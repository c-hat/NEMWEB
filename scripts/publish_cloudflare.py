#!/usr/bin/env python3
"""Publish generated NEMWEB payloads to Cloudflare R2 and D1.

This script keeps the current static data files as the source of truth during
the migration. It publishes compatibility JSON to R2 and updates D1 catalog
metadata so the Worker can serve browser API responses from Cloudflare storage.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEFAULT_BUCKET = "nemweb-data-prod"
DEFAULT_DATABASE = "nemweb-catalog-prod"
DEFAULT_WORKER_DIR = ROOT / "worker"
ANALYSIS_ID = "demand-forecast-error-ranking"
ANALYSIS_VERSION = "1.0.0"
REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]


@dataclass(frozen=True)
class Upload:
    source: Path
    key: str


@dataclass(frozen=True)
class PublishPlan:
    uploads: list[Upload]
    dates: list[str]
    today: str | None
    analysis_payload: dict[str, Any] | None
    sql: str


DATASETS = [
    {
        "id": "aemo-nemweb.demand.forecast",
        "label": "AEMO NEMWEB demand forecast",
        "metric": "demand",
        "cadence": "30m",
        "regions": REGIONS,
        "units": "MW",
        "schema_version": "compat-day-v1",
    },
    {
        "id": "aemo-nemweb.demand.actual",
        "label": "AEMO NEMWEB demand actual",
        "metric": "demand",
        "cadence": "30m",
        "regions": REGIONS,
        "units": "MW",
        "schema_version": "compat-day-v1",
    },
    {
        "id": "aemo-nemweb.rooftopPv.forecast",
        "label": "AEMO NEMWEB rooftop PV forecast",
        "metric": "rooftopPv",
        "cadence": "30m",
        "regions": REGIONS,
        "units": "MW",
        "schema_version": "compat-day-v1",
    },
    {
        "id": "aemo-nemweb.rooftopPv.actual",
        "label": "AEMO NEMWEB rooftop PV actual",
        "metric": "rooftopPv",
        "cadence": "30m",
        "regions": REGIONS,
        "units": "MW",
        "schema_version": "compat-day-v1",
    },
]


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def sql_quote(value: str | None) -> str:
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def sql_json(value: Any) -> str:
    return sql_quote(json.dumps(value, separators=(",", ":"), sort_keys=True))


def statement(sql: str) -> str:
    return sql.strip() + ";\n"


def load_dates(data_dir: Path) -> list[str]:
    index = read_json(data_dir / "index.json")
    if not isinstance(index, list):
        raise ValueError("index.json must be an array")

    dates: list[str] = []
    for row in index:
        if not isinstance(row, dict) or not isinstance(row.get("date"), str):
            raise ValueError("index.json rows must contain a date string")
        date = row["date"]
        if not DATE_RE.match(date):
            raise ValueError(f"invalid date in index.json: {date}")
        day_file = data_dir / f"{date}.json"
        if not day_file.exists():
            raise FileNotFoundError(f"indexed day is missing: {day_file}")
        dates.append(date)
    return dates


def analysis_wrapper(data_dir: Path, generated_at: str) -> dict[str, Any] | None:
    path = data_dir / "demand-error-rankings.json"
    if not path.exists():
        return None

    compat = read_json(path)
    return {
        "id": ANALYSIS_ID,
        "type": "forecast-error-ranking",
        "version": ANALYSIS_VERSION,
        "inputs": ["aemo-nemweb.demand.forecast", "aemo-nemweb.demand.actual"],
        "parameters": {
            "metric": compat.get("metric"),
            "topN": compat.get("topN"),
        },
        "generatedAt": generated_at,
        "data": compat,
    }


def today_date(data_dir: Path) -> str | None:
    path = data_dir / "today.json"
    if not path.exists():
        return None
    payload = read_json(path)
    date = payload.get("tradingDate")
    if not isinstance(date, str) or not DATE_RE.match(date):
        raise ValueError("today.json must contain tradingDate as YYYY-MM-DD")
    return date


def build_uploads(
    data_dir: Path,
    dates: Iterable[str],
    today: str | None,
    analysis_payload_path: Path | None,
    live_path: Path | None,
    only_live: bool,
) -> list[Upload]:
    uploads: list[Upload] = []

    if live_path is not None:
        uploads.append(Upload(live_path, "compat/live.json"))
        if only_live:
            return uploads

    for date in dates:
        uploads.append(Upload(data_dir / f"{date}.json", f"compat/day/{date}.json"))

    if today:
        uploads.append(Upload(data_dir / "today.json", "compat/today.json"))
        uploads.append(Upload(data_dir / "today.json", f"compat/day/{today}.json"))

    rankings = data_dir / "demand-error-rankings.json"
    if rankings.exists():
        uploads.append(Upload(rankings, "compat/demand-error-rankings.json"))
    if analysis_payload_path is not None:
        uploads.append(Upload(analysis_payload_path, f"analysis/{ANALYSIS_ID}/{ANALYSIS_VERSION}.json"))

    # Publish pointers last so clients never see an index/latest object before
    # the day payloads it references are present.
    uploads.extend(
        [
            Upload(data_dir / "index.json", "compat/index.json"),
            Upload(data_dir / "latest.json", "compat/latest.json"),
        ]
    )

    return uploads


def build_sql(dates: list[str], today: str | None, analysis_payload: dict[str, Any] | None) -> str:
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    all_dates = list(dates)
    if today and today not in all_dates:
        all_dates.append(today)

    run_id = f"compat-public-data-{all_dates[-1] if all_dates else generated_at[:10]}"
    refs = ["compat/index.json", "compat/latest.json"] + [
        f"compat/day/{date}.json" for date in all_dates
    ]

    lines = [
        statement(
            "INSERT INTO sources (id, label, kind, config_json, updated_at) VALUES "
            f"('aemo-nemweb', 'AEMO NEMWEB', 'nemweb', {sql_json({'projection': 'public/data compatibility'})}, "
            "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) "
            "ON CONFLICT(id) DO UPDATE SET label=excluded.label, kind=excluded.kind, "
            "config_json=excluded.config_json, updated_at=excluded.updated_at"
        ),
        statement(
            "INSERT INTO source_runs "
            "(id, source_id, params_json, started_at, finished_at, status, error, r2_refs_json) VALUES "
            f"({sql_quote(run_id)}, 'aemo-nemweb', {sql_json({'dates': len(dates), 'today': today})}, "
            f"{sql_quote(generated_at)}, {sql_quote(generated_at)}, 'success', NULL, {sql_json(refs)}) "
            "ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at, "
            "status=excluded.status, error=excluded.error, r2_refs_json=excluded.r2_refs_json"
        ),
    ]

    for dataset in DATASETS:
        lines.append(
            statement(
                "INSERT INTO datasets "
                "(id, label, metric, cadence, regions_json, units, schema_version, updated_at) VALUES "
                f"({sql_quote(dataset['id'])}, {sql_quote(dataset['label'])}, "
                f"{sql_quote(dataset['metric'])}, {sql_quote(dataset['cadence'])}, "
                f"{sql_json(dataset['regions'])}, {sql_quote(dataset['units'])}, "
                f"{sql_quote(dataset['schema_version'])}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) "
                "ON CONFLICT(id) DO UPDATE SET label=excluded.label, metric=excluded.metric, "
                "cadence=excluded.cadence, regions_json=excluded.regions_json, "
                "units=excluded.units, schema_version=excluded.schema_version, updated_at=excluded.updated_at"
            )
        )

    for date in dates:
        for dataset in DATASETS:
            lines.append(
                availability_statement(dataset["id"], date, "available", f"compat/day/{date}.json", run_id)
            )

    if today and today not in dates:
        for dataset in DATASETS:
            lines.append(
                availability_statement(
                    dataset["id"],
                    today,
                    "partial",
                    f"compat/day/{today}.json",
                    run_id,
                    {"inProgress": True, "projection": "today.json"},
                )
            )

    if analysis_payload is not None:
        parameters = analysis_payload["parameters"]
        inputs = analysis_payload["inputs"]
        lines.extend(
            [
                statement(
                    "INSERT INTO analyses "
                    "(id, type, label, inputs_json, parameters_json, version, updated_at) VALUES "
                    f"({sql_quote(ANALYSIS_ID)}, 'forecast-error-ranking', "
                    "'Demand forecast error ranking', "
                    f"{sql_json(inputs)}, {sql_json(parameters)}, {sql_quote(ANALYSIS_VERSION)}, "
                    "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) "
                    "ON CONFLICT(id) DO UPDATE SET type=excluded.type, label=excluded.label, "
                    "inputs_json=excluded.inputs_json, parameters_json=excluded.parameters_json, "
                    "version=excluded.version, updated_at=excluded.updated_at"
                ),
                statement(
                    "INSERT INTO analysis_availability "
                    "(analysis_id, date_or_range, r2_key, generated_at, status, quality_json) VALUES "
                    f"({sql_quote(ANALYSIS_ID)}, 'all', "
                    f"{sql_quote(f'analysis/{ANALYSIS_ID}/{ANALYSIS_VERSION}.json')}, "
                    f"{sql_quote(analysis_payload['generatedAt'])}, 'available', {sql_json({})}) "
                    "ON CONFLICT(analysis_id, date_or_range) DO UPDATE SET "
                    "r2_key=excluded.r2_key, generated_at=excluded.generated_at, "
                    "status=excluded.status, quality_json=excluded.quality_json"
                ),
            ]
        )

    return "".join(lines)


def availability_statement(
    dataset_id: str,
    date: str,
    status: str,
    r2_key: str,
    run_id: str,
    quality: dict[str, Any] | None = None,
) -> str:
    return statement(
        "INSERT INTO dataset_availability "
        "(dataset_id, date, status, r2_key, quality_json, source_run_id, updated_at) VALUES "
        f"({sql_quote(dataset_id)}, {sql_quote(date)}, {sql_quote(status)}, "
        f"{sql_quote(r2_key)}, {sql_json(quality or {'projection': 'compat-day'})}, "
        f"{sql_quote(run_id)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) "
        "ON CONFLICT(dataset_id, date) DO UPDATE SET status=excluded.status, "
        "r2_key=excluded.r2_key, quality_json=excluded.quality_json, "
        "source_run_id=excluded.source_run_id, updated_at=excluded.updated_at"
    )


def create_plan(
    data_dir: Path,
    generated_at: str,
    temp_dir: Path,
    live_path: Path | None = None,
    only_live: bool = False,
) -> PublishPlan:
    if only_live:
        if live_path is None:
            raise ValueError("--only-live requires --live")
        return PublishPlan(
            uploads=build_uploads(data_dir, [], None, None, live_path, only_live=True),
            dates=[],
            today=None,
            analysis_payload=None,
            sql="",
        )

    dates = load_dates(data_dir)
    today = today_date(data_dir)
    analysis = analysis_wrapper(data_dir, generated_at)
    analysis_path: Path | None = None
    if analysis is not None:
        analysis_path = temp_dir / f"{ANALYSIS_ID}-{ANALYSIS_VERSION}.json"
        write_json(analysis_path, analysis)

    sql = build_sql(dates, today, analysis)
    uploads = build_uploads(data_dir, dates, today, analysis_path, live_path, only_live=False)
    return PublishPlan(uploads=uploads, dates=dates, today=today, analysis_payload=analysis, sql=sql)


def wrangler_command(worker_dir: Path) -> list[str]:
    local = worker_dir / "node_modules" / ".bin" / "wrangler"
    if local.exists():
        return [str(local)]
    return ["npx", "wrangler"]


def run(cmd: list[str], cwd: Path, dry_run: bool) -> None:
    if dry_run:
        print("+", " ".join(cmd))
        return
    subprocess.run(cmd, cwd=cwd, check=True)


def upload_one(
    wrangler: list[str],
    worker_dir: Path,
    bucket: str,
    upload: Upload,
    dry_run: bool,
) -> str:
    cmd = [
        *wrangler,
        "r2",
        "object",
        "put",
        f"{bucket}/{upload.key}",
        "--file",
        str(upload.source),
        "--content-type",
        "application/json",
        "--remote",
    ]
    run(cmd, worker_dir, dry_run)
    return upload.key


def publish_uploads(
    wrangler: list[str],
    worker_dir: Path,
    bucket: str,
    uploads: list[Upload],
    concurrency: int,
    dry_run: bool,
) -> None:
    pointer_keys = {"compat/index.json", "compat/latest.json"}
    body_uploads = [upload for upload in uploads if upload.key not in pointer_keys]
    pointer_uploads = [upload for upload in uploads if upload.key in pointer_keys]

    if concurrency <= 1 or dry_run:
        for upload in [*body_uploads, *pointer_uploads]:
            upload_one(wrangler, worker_dir, bucket, upload, dry_run)
        return

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {
            executor.submit(upload_one, wrangler, worker_dir, bucket, upload, dry_run): upload
            for upload in body_uploads
        }
        done = 0
        for future in as_completed(futures):
            future.result()
            done += 1
            if done % 25 == 0 or done == len(body_uploads):
                print(f"uploaded {done}/{len(body_uploads)} body objects")

    for upload in pointer_uploads:
        upload_one(wrangler, worker_dir, bucket, upload, dry_run)


def publish_sql(
    wrangler: list[str],
    worker_dir: Path,
    database: str,
    sql: str,
    dry_run: bool,
) -> None:
    if not sql:
        return
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write(sql)
        sql_path = Path(f.name)
    try:
        run([*wrangler, "d1", "execute", database, "--remote", "--file", str(sql_path), "--yes"], worker_dir, dry_run)
    finally:
        if not dry_run:
            sql_path.unlink(missing_ok=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "public" / "data")
    parser.add_argument("--bucket", default=os.environ.get("NEMWEB_R2_BUCKET", DEFAULT_BUCKET))
    parser.add_argument("--database", default=os.environ.get("NEMWEB_D1_DATABASE_NAME", DEFAULT_DATABASE))
    parser.add_argument("--worker-dir", type=Path, default=DEFAULT_WORKER_DIR)
    parser.add_argument("--live", type=Path, help="Upload a live-data JSON file to compat/live.json")
    parser.add_argument("--only-live", action="store_true", help="Only publish --live to R2")
    parser.add_argument("--skip-d1", action="store_true", help="Upload R2 objects but skip D1 catalog writes")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    worker_dir = args.worker_dir.resolve()
    data_dir = args.data_dir.resolve()
    live_path = args.live.resolve() if args.live else None

    with tempfile.TemporaryDirectory() as tmp:
        plan = create_plan(data_dir, generated_at, Path(tmp), live_path=live_path, only_live=args.only_live)
        print(
            f"publish plan: {len(plan.uploads)} R2 objects"
            f"{f', {len(plan.dates)} historical days' if plan.dates else ''}"
            f"{f', today={plan.today}' if plan.today else ''}"
        )
        wrangler = wrangler_command(worker_dir)
        publish_uploads(wrangler, worker_dir, args.bucket, plan.uploads, args.concurrency, args.dry_run)
        if args.skip_d1:
            print("D1 publish skipped")
        else:
            publish_sql(wrangler, worker_dir, args.database, plan.sql, args.dry_run)

    print("publish complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
