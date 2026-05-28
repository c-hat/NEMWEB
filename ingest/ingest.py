"""NEMWEB forecast tracker ingestion CLI.

For a given trading day D (in AEST), pulls:
  - the day-ahead operational demand forecast snapshot issued ~D-1 16:00 AEST,
  - the realised operational demand for D,
  - the day-ahead rooftop PV forecast snapshot issued ~D-1 16:00 AEST,
  - the realised rooftop PV (TYPE=MEASUREMENT) for D,
then writes one JSON per day into the output directory along with
latest.json and index.json pointers.

Usage:
    uv run python ingest.py --date 2026-05-27
    uv run python ingest.py --backfill 30
    uv run python ingest.py --date 2026-05-27 --out ../public/data
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, date as date_cls
from pathlib import Path

import pandas as pd
import requests

from nemweb import (
    AEST,
    DirectoryEntry,
    download_zip,
    entries_in_range,
    list_directory,
    pick_snapshot_at_or_before,
    read_aemo_zip,
)


log = logging.getLogger("ingest")

REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]

URL_DEMAND_FORECAST = "https://nemweb.com.au/Reports/Current/Operational_Demand/FORECAST_HH/"
URL_DEMAND_ACTUAL = "https://nemweb.com.au/Reports/Current/Operational_Demand/ACTUAL_HH/"
URL_ROOFTOP_FORECAST = "https://nemweb.com.au/Reports/Current/ROOFTOP_PV/FORECAST/"
URL_ROOFTOP_ACTUAL = "https://nemweb.com.au/Reports/Current/ROOFTOP_PV/ACTUAL/"


def half_hour_intervals(trading_day: date_cls) -> list[datetime]:
    """The 48 half-hour-ending interval timestamps for the trading day (AEST)."""
    start = datetime(trading_day.year, trading_day.month, trading_day.day, 0, 30, tzinfo=AEST)
    return [start + timedelta(minutes=30 * i) for i in range(48)]


def _parse_aemo_dt(s: str) -> datetime | None:
    """AEMO interval timestamps look like '2026/05/28 00:30:00' (AEST naive)."""
    if not s or pd.isna(s):
        return None
    s = s.strip().strip('"')
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=AEST)
        except ValueError:
            continue
    return None


def _series_for_region(
    rows: pd.DataFrame,
    region: str,
    value_col: str,
    intervals: list[datetime],
    interval_col: str = "INTERVAL_DATETIME",
    region_col: str = "REGIONID",
) -> list[float | None]:
    """Project rows onto the 48-interval grid for one region.

    Missing intervals become None. Numeric coercion is permissive.
    """
    sub = rows[rows[region_col] == region]
    by_dt: dict[datetime, float] = {}
    for _, r in sub.iterrows():
        dt = _parse_aemo_dt(str(r[interval_col]))
        if dt is None:
            continue
        try:
            v = float(r[value_col])
        except (TypeError, ValueError):
            continue
        by_dt[dt] = v
    return [by_dt.get(t) for t in intervals]


# --- Demand --------------------------------------------------------------

def fetch_demand_forecast(trading_day: date_cls, session: requests.Session | None = None) -> tuple[pd.DataFrame, DirectoryEntry]:
    """Pick the forecast snapshot issued nearest D-1 16:00 AEST and return its rows."""
    cutoff = datetime(trading_day.year, trading_day.month, trading_day.day, tzinfo=AEST) - timedelta(hours=7)  # D-1 17:00
    entries = list_directory(URL_DEMAND_FORECAST, session=session)
    chosen = pick_snapshot_at_or_before(entries, cutoff)
    if chosen is None:
        raise RuntimeError(f"No demand forecast snapshot at or before {cutoff.isoformat()}")
    log.info("demand forecast snapshot: %s (issued %s)", chosen.filename, chosen.timestamp)
    tables = read_aemo_zip(download_zip(chosen.url, session=session))
    # AEMO publishes this as "OPERATIONAL_DEMAND" report with "FORECAST_HH" table,
    # or sometimes "DEMANDOPERATIONALFORECAST". Match either.
    for key, df in tables.items():
        if "FORECAST" in key.upper() and "OPERATIONAL_DEMAND_POE50" in {c.upper() for c in df.columns}:
            return df, chosen
    raise RuntimeError(f"Demand forecast table not found in {chosen.filename}; got: {list(tables)}")


def fetch_demand_actual(trading_day: date_cls, session: requests.Session | None = None) -> pd.DataFrame:
    """Concatenate all ACTUAL_HH files whose filename timestamp falls inside D (AEST).

    AEMO's ACTUAL_HH files are issued repeatedly through the day; one file per
    publish run carries the latest half-hour-ending interval(s). Pulling every
    file whose timestamp is inside D gives us 48 intervals across the day.
    """
    start = datetime(trading_day.year, trading_day.month, trading_day.day, tzinfo=AEST)
    end = start + timedelta(days=1)
    entries = list_directory(URL_DEMAND_ACTUAL, session=session)
    in_window = entries_in_range(entries, start, end + timedelta(hours=6))  # slop for late files
    if not in_window:
        raise RuntimeError(f"No demand actual files in window {start.isoformat()}..{end.isoformat()}")
    frames: list[pd.DataFrame] = []
    for e in in_window:
        tables = read_aemo_zip(download_zip(e.url, session=session))
        for key, df in tables.items():
            cols_upper = {c.upper() for c in df.columns}
            if "OPERATIONAL_DEMAND" in cols_upper and "INTERVAL_DATETIME" in cols_upper:
                frames.append(df)
    if not frames:
        raise RuntimeError("Demand actual table not found in any of the day's ACTUAL_HH files")
    return pd.concat(frames, ignore_index=True)


# --- Rooftop PV ----------------------------------------------------------

def fetch_rooftop_forecast(trading_day: date_cls, session: requests.Session | None = None) -> tuple[pd.DataFrame, DirectoryEntry]:
    cutoff = datetime(trading_day.year, trading_day.month, trading_day.day, tzinfo=AEST) - timedelta(hours=7)
    entries = list_directory(URL_ROOFTOP_FORECAST, session=session)
    chosen = pick_snapshot_at_or_before(entries, cutoff)
    if chosen is None:
        raise RuntimeError(f"No rooftop PV forecast snapshot at or before {cutoff.isoformat()}")
    log.info("rooftop forecast snapshot: %s (issued %s)", chosen.filename, chosen.timestamp)
    tables = read_aemo_zip(download_zip(chosen.url, session=session))
    for key, df in tables.items():
        cols_upper = {c.upper() for c in df.columns}
        if "POWERPOE50" in cols_upper and "REGIONID" in cols_upper:
            return df, chosen
    raise RuntimeError(f"Rooftop forecast table not found in {chosen.filename}; got: {list(tables)}")


def fetch_rooftop_actual(trading_day: date_cls, session: requests.Session | None = None) -> pd.DataFrame:
    start = datetime(trading_day.year, trading_day.month, trading_day.day, tzinfo=AEST)
    end = start + timedelta(days=1)
    entries = list_directory(URL_ROOFTOP_ACTUAL, session=session)
    in_window = entries_in_range(entries, start, end + timedelta(hours=6))
    if not in_window:
        raise RuntimeError(f"No rooftop actual files in window {start.isoformat()}..{end.isoformat()}")
    frames: list[pd.DataFrame] = []
    for e in in_window:
        tables = read_aemo_zip(download_zip(e.url, session=session))
        for _, df in tables.items():
            cols_upper = {c.upper() for c in df.columns}
            if "POWER" in cols_upper and "REGIONID" in cols_upper and "INTERVAL_DATETIME" in cols_upper:
                frames.append(df)
    if not frames:
        raise RuntimeError("Rooftop actual table not found in any of the day's files")
    df = pd.concat(frames, ignore_index=True)
    if "TYPE" in df.columns:
        df = df[df["TYPE"].astype(str).str.upper() == "MEASUREMENT"]
    return df


# --- Composition ---------------------------------------------------------

def build_day_payload(trading_day: date_cls, session: requests.Session | None = None) -> dict:
    intervals = half_hour_intervals(trading_day)
    interval_iso = [t.strftime("%Y-%m-%dT%H:%M%z").replace("+1000", "+10:00") for t in intervals]

    demand_fc, demand_fc_entry = fetch_demand_forecast(trading_day, session=session)
    demand_actual = fetch_demand_actual(trading_day, session=session)
    rooftop_fc, rooftop_fc_entry = fetch_rooftop_forecast(trading_day, session=session)
    rooftop_actual = fetch_rooftop_actual(trading_day, session=session)

    # Issue time recorded as the snapshot whose timestamp drove the demand pick
    # (demand and rooftop snapshots may differ slightly; we report demand's).
    issued = demand_fc_entry.timestamp.strftime("%Y-%m-%dT%H:%M%z").replace("+1000", "+10:00")

    regions_payload: dict[str, dict] = {}
    for region in REGIONS:
        demand_block = {
            "intervals": interval_iso,
            "poe10": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE10", intervals),
            "poe50": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE50", intervals),
            "poe90": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE90", intervals),
            "actual": _series_for_region(demand_actual, region, "OPERATIONAL_DEMAND", intervals),
        }
        rooftop_block = {
            "intervals": interval_iso,
            "poe10": _series_for_region(rooftop_fc, region, "POWERPOELOW", intervals),
            "poe50": _series_for_region(rooftop_fc, region, "POWERPOE50", intervals),
            "poe90": _series_for_region(rooftop_fc, region, "POWERPOEHIGH", intervals),
            "actual": _series_for_region(rooftop_actual, region, "POWER", intervals),
        }
        regions_payload[region] = {"demand": demand_block, "rooftopPv": rooftop_block}

    return {
        "tradingDate": trading_day.isoformat(),
        "forecastIssuedAt": issued,
        "regions": regions_payload,
    }


def write_outputs(payload: dict, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    day = payload["tradingDate"]
    day_path = out_dir / f"{day}.json"
    day_path.write_text(json.dumps(payload, separators=(",", ":")))

    # Rebuild index.json by globbing dated files
    dated = sorted(p.stem for p in out_dir.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json"))
    (out_dir / "index.json").write_text(json.dumps([{"date": d} for d in dated], separators=(",", ":")))

    if dated:
        latest = dated[-1]
        (out_dir / "latest.json").write_text(
            json.dumps({"date": latest, "path": f"{latest}.json"}, separators=(",", ":"))
        )

    return day_path


def ingest_day(trading_day: date_cls, out_dir: Path, session: requests.Session | None = None) -> Path:
    log.info("ingesting trading day %s", trading_day.isoformat())
    payload = build_day_payload(trading_day, session=session)
    return write_outputs(payload, out_dir)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--date", type=lambda s: datetime.strptime(s, "%Y-%m-%d").date(),
                   help="Trading day D (AEST), YYYY-MM-DD")
    g.add_argument("--backfill", type=int, metavar="N",
                   help="Ingest the last N days, ending yesterday (AEST)")
    p.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "public" / "data",
                   help="Output directory for JSON (default: ../public/data)")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    today_aest = datetime.now(AEST).date()
    if args.backfill:
        days = [today_aest - timedelta(days=i) for i in range(1, args.backfill + 1)]
    else:
        days = [args.date]

    session = requests.Session()
    session.headers["User-Agent"] = "nemweb-forecast-tracker/0.1"

    failures: list[tuple[date_cls, str]] = []
    for d in days:
        try:
            out_path = ingest_day(d, args.out, session=session)
            log.info("wrote %s", out_path)
        except Exception as exc:  # noqa: BLE001
            log.warning("skipped %s: %s", d.isoformat(), exc)
            failures.append((d, str(exc)))

    if failures and len(failures) == len(days):
        log.error("all days failed")
        return 1
    if failures:
        log.warning("%d/%d days skipped", len(failures), len(days))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
