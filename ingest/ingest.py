"""NEMWEB forecast tracker ingestion CLI.

For a given trading day D (in AEST), pulls:
  - the day-ahead operational demand forecast snapshot issued by D-1 17:00 AEST,
  - the realised operational demand for D,
  - the day-ahead rooftop PV forecast snapshot issued by D-1 17:00 AEST,
  - the realised rooftop PV (TYPE=MEASUREMENT) for D,
then writes one JSON per day into the output directory along with
latest.json and index.json pointers.

Data source:
    By default the live NEMWEB site is used. Point at local fixtures (or any
    mirror) with --source or the NEMWEB_SOURCE env var; a path is treated as a
    local fixture directory, an http(s):// value as a base URL. The same code
    path runs in both cases.

Usage:
    uv run python ingest.py --date 2026-05-27
    uv run python ingest.py --backfill 30
    uv run python ingest.py --date 2026-05-27 --out ../public/data
    uv run python ingest.py --date 2026-05-28 --source ../tests/fixtures/nemweb
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime, timedelta, date as date_cls
from pathlib import Path

import pandas as pd

if __package__:
    from .dataset_contracts import NormalizedDataset, NormalizedDay, SourceAdapter
    from .nemweb import (
        AEST,
        DirectoryEntry,
        Source,
        entries_in_range,
        make_source,
        pick_snapshot_at_or_before,
    )
else:  # pragma: no cover - script execution path
    from dataset_contracts import NormalizedDataset, NormalizedDay, SourceAdapter
    from nemweb import (
        AEST,
        DirectoryEntry,
        Source,
        entries_in_range,
        make_source,
        pick_snapshot_at_or_before,
    )


log = logging.getLogger("ingest")

REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]

# Report directories, relative to the source base (live site or fixture root).
PATH_DEMAND_FORECAST = "Reports/Current/Operational_Demand/FORECAST_HH"
PATH_DEMAND_ACTUAL = "Reports/Current/Operational_Demand/ACTUAL_HH"
PATH_ROOFTOP_FORECAST = "Reports/Current/ROOFTOP_PV/FORECAST"
PATH_ROOFTOP_ACTUAL = "Reports/Current/ROOFTOP_PV/ACTUAL"


class SourceDataUnavailable(RuntimeError):
    """Raised when current report files are unavailable for a trading day."""

    def __init__(self, message: str, *, archive_hint: bool = False):
        if archive_hint:
            message = f"{message}; Reports/Current may have rolled off and ARCHIVE fallback is pending"
        super().__init__(message)
        self.archive_hint = archive_hint


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

    Missing intervals become None. Numeric coercion is permissive. A column or
    region absent from the frame yields an all-None series rather than raising,
    so a forecast file that omits a metric (or a region) degrades gracefully.
    """
    if value_col not in rows.columns or region_col not in rows.columns:
        return [None] * len(intervals)
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

def _forecast_cutoff(trading_day: date_cls) -> datetime:
    """Latest issue time accepted for the day-ahead snapshot: D-1 17:00 AEST."""
    return datetime(trading_day.year, trading_day.month, trading_day.day, tzinfo=AEST) - timedelta(hours=7)


def fetch_demand_forecast(trading_day: date_cls, source: Source) -> tuple[pd.DataFrame, DirectoryEntry]:
    """Pick the forecast snapshot issued at or before D-1 17:00 AEST and return its rows."""
    cutoff = _forecast_cutoff(trading_day)
    entries = source.list_directory(PATH_DEMAND_FORECAST)
    if not entries:
        raise SourceDataUnavailable(
            f"No demand forecast files listed under {PATH_DEMAND_FORECAST}",
            archive_hint=True,
        )
    chosen = pick_snapshot_at_or_before(entries, cutoff)
    if chosen is None:
        raise SourceDataUnavailable(
            f"No demand forecast snapshot at or before {cutoff.isoformat()}",
            archive_hint=True,
        )
    log.info("demand forecast snapshot: %s (issued %s)", chosen.filename, chosen.timestamp)
    tables = source.read_tables(chosen)
    # AEMO publishes this as "OPERATIONAL_DEMAND" report with "FORECAST_HH" table,
    # or sometimes "DEMANDOPERATIONALFORECAST". Match on columns rather than the
    # table name so either naming works.
    for key, df in tables.items():
        if "FORECAST" in key.upper() and "OPERATIONAL_DEMAND_POE50" in {c.upper() for c in df.columns}:
            return df, chosen
    raise RuntimeError(f"Demand forecast table not found in {chosen.filename}; got: {list(tables)}")


def fetch_demand_actual(trading_day: date_cls, source: Source) -> pd.DataFrame:
    """Concatenate all ACTUAL_HH files whose filename timestamp falls inside D (AEST).

    AEMO's ACTUAL_HH files are issued repeatedly through the day; one file per
    publish run carries the latest half-hour-ending interval(s). Pulling every
    file whose timestamp is inside D gives us 48 intervals across the day.
    """
    start = datetime(trading_day.year, trading_day.month, trading_day.day, tzinfo=AEST)
    end = start + timedelta(days=1)
    entries = source.list_directory(PATH_DEMAND_ACTUAL)
    if not entries:
        raise SourceDataUnavailable(
            f"No demand actual files listed under {PATH_DEMAND_ACTUAL}",
            archive_hint=True,
        )
    in_window = entries_in_range(entries, start, end + timedelta(hours=6))  # slop for late files
    if not in_window:
        raise SourceDataUnavailable(
            f"No demand actual files in window {start.isoformat()}..{end.isoformat()}",
            archive_hint=True,
        )
    frames: list[pd.DataFrame] = []
    for e in in_window:
        tables = source.read_tables(e)
        for key, df in tables.items():
            cols_upper = {c.upper() for c in df.columns}
            if "OPERATIONAL_DEMAND" in cols_upper and "INTERVAL_DATETIME" in cols_upper:
                frames.append(df)
    if not frames:
        raise RuntimeError("Demand actual table not found in any of the day's ACTUAL_HH files")
    return pd.concat(frames, ignore_index=True)


# --- Rooftop PV ----------------------------------------------------------

def fetch_rooftop_forecast(trading_day: date_cls, source: Source) -> tuple[pd.DataFrame, DirectoryEntry]:
    cutoff = _forecast_cutoff(trading_day)
    entries = source.list_directory(PATH_ROOFTOP_FORECAST)
    if not entries:
        raise SourceDataUnavailable(
            f"No rooftop PV forecast files listed under {PATH_ROOFTOP_FORECAST}",
            archive_hint=True,
        )
    chosen = pick_snapshot_at_or_before(entries, cutoff)
    if chosen is None:
        raise SourceDataUnavailable(
            f"No rooftop PV forecast snapshot at or before {cutoff.isoformat()}",
            archive_hint=True,
        )
    log.info("rooftop forecast snapshot: %s (issued %s)", chosen.filename, chosen.timestamp)
    tables = source.read_tables(chosen)
    for key, df in tables.items():
        cols_upper = {c.upper() for c in df.columns}
        if "POWERPOE50" in cols_upper and "REGIONID" in cols_upper:
            return df, chosen
    raise RuntimeError(f"Rooftop forecast table not found in {chosen.filename}; got: {list(tables)}")


def fetch_rooftop_actual(trading_day: date_cls, source: Source) -> pd.DataFrame:
    start = datetime(trading_day.year, trading_day.month, trading_day.day, tzinfo=AEST)
    end = start + timedelta(days=1)
    entries = source.list_directory(PATH_ROOFTOP_ACTUAL)
    if not entries:
        raise SourceDataUnavailable(
            f"No rooftop actual files listed under {PATH_ROOFTOP_ACTUAL}",
            archive_hint=True,
        )
    in_window = entries_in_range(entries, start, end + timedelta(hours=6))
    if not in_window:
        raise SourceDataUnavailable(
            f"No rooftop actual files in window {start.isoformat()}..{end.isoformat()}",
            archive_hint=True,
        )
    frames: list[pd.DataFrame] = []
    for e in in_window:
        tables = source.read_tables(e)
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

def _interval_grid(trading_day: date_cls) -> tuple[list[datetime], list[str]]:
    intervals = half_hour_intervals(trading_day)
    interval_iso = [t.strftime("%Y-%m-%dT%H:%M%z").replace("+1000", "+10:00") for t in intervals]
    return intervals, interval_iso


def _region_blocks(
    demand_fc: pd.DataFrame,
    rooftop_fc: pd.DataFrame,
    demand_actual: pd.DataFrame | None,
    rooftop_actual: pd.DataFrame | None,
    intervals: list[datetime],
    interval_iso: list[str],
) -> dict[str, dict]:
    """Build the per-region demand/rooftop blocks.

    ``demand_actual``/``rooftop_actual`` may be None (the live "today" case),
    in which case the actual arrays are all-null and only the forecast plume is
    populated.
    """
    empty = [None] * len(intervals)

    def actual_of(df: pd.DataFrame | None, region: str, col: str) -> list[float | None]:
        return list(empty) if df is None else _series_for_region(df, region, col, intervals)

    regions_payload: dict[str, dict] = {}
    for region in REGIONS:
        demand_block = {
            "intervals": interval_iso,
            "poe10": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE10", intervals),
            "poe50": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE50", intervals),
            "poe90": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE90", intervals),
            "actual": actual_of(demand_actual, region, "OPERATIONAL_DEMAND"),
        }
        rooftop_block = {
            "intervals": interval_iso,
            # POE convention is kept consistent with demand: poe10 is the HIGH
            # band (exceeded only ~10% of the time), poe90 the LOW band. For
            # rooftop that means poe10 <- POWERPOEHIGH and poe90 <- POWERPOELOW.
            # Confirmed against live data (POWERPOELOW < POWERPOE50 <
            # POWERPOEHIGH, zero band-order violations); see FLAGS.md.
            "poe10": _series_for_region(rooftop_fc, region, "POWERPOEHIGH", intervals),
            "poe50": _series_for_region(rooftop_fc, region, "POWERPOE50", intervals),
            "poe90": _series_for_region(rooftop_fc, region, "POWERPOELOW", intervals),
            "actual": actual_of(rooftop_actual, region, "POWER"),
        }
        regions_payload[region] = {"demand": demand_block, "rooftopPv": rooftop_block}
    return regions_payload


def _dataset(
    *,
    trading_day: date_cls,
    source_id: str,
    metric: str,
    kind: str,
    intervals: list[str],
    values: dict[str, dict[str, list[float | None]]],
) -> NormalizedDataset:
    return NormalizedDataset(
        id=f"{source_id}.{metric}.{kind}.{trading_day.isoformat()}",
        source=source_id,
        metric=metric,
        kind=kind,
        cadence="30m",
        units="MW",
        interval_timezone="AEST+10:00",
        intervals=intervals,
        regions=REGIONS.copy(),
        values=values,
    )


class NemwebDayAdapter:
    """NEMWEB adapter that emits normalized day datasets."""

    id = "aemo-nemweb"

    def __init__(self, source: Source):
        self.source = source

    def build_day(self, trading_day: date_cls, include_actuals: bool = True) -> NormalizedDay:
        intervals, interval_iso = _interval_grid(trading_day)

        demand_fc, demand_fc_entry = fetch_demand_forecast(trading_day, self.source)
        rooftop_fc, _ = fetch_rooftop_forecast(trading_day, self.source)
        demand_actual = fetch_demand_actual(trading_day, self.source) if include_actuals else None
        rooftop_actual = fetch_rooftop_actual(trading_day, self.source) if include_actuals else None

        issued = demand_fc_entry.timestamp.strftime("%Y-%m-%dT%H:%M%z").replace("+1000", "+10:00")

        demand_forecast_values: dict[str, dict[str, list[float | None]]] = {}
        rooftop_forecast_values: dict[str, dict[str, list[float | None]]] = {}
        demand_actual_values: dict[str, dict[str, list[float | None]]] = {}
        rooftop_actual_values: dict[str, dict[str, list[float | None]]] = {}

        empty = [None] * len(intervals)
        for region in REGIONS:
            demand_forecast_values[region] = {
                "poe10": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE10", intervals),
                "poe50": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE50", intervals),
                "poe90": _series_for_region(demand_fc, region, "OPERATIONAL_DEMAND_POE90", intervals),
            }
            rooftop_forecast_values[region] = {
                "poe10": _series_for_region(rooftop_fc, region, "POWERPOEHIGH", intervals),
                "poe50": _series_for_region(rooftop_fc, region, "POWERPOE50", intervals),
                "poe90": _series_for_region(rooftop_fc, region, "POWERPOELOW", intervals),
            }
            demand_actual_values[region] = {
                "actual": list(empty)
                if demand_actual is None
                else _series_for_region(demand_actual, region, "OPERATIONAL_DEMAND", intervals),
            }
            rooftop_actual_values[region] = {
                "actual": list(empty)
                if rooftop_actual is None
                else _series_for_region(rooftop_actual, region, "POWER", intervals),
            }

        datasets = {
            "demandForecast": _dataset(
                trading_day=trading_day,
                source_id=self.id,
                metric="demand",
                kind="forecast",
                intervals=interval_iso,
                values=demand_forecast_values,
            ),
            "demandActual": _dataset(
                trading_day=trading_day,
                source_id=self.id,
                metric="demand",
                kind="actual",
                intervals=interval_iso,
                values=demand_actual_values,
            ),
            "rooftopPvForecast": _dataset(
                trading_day=trading_day,
                source_id=self.id,
                metric="rooftopPv",
                kind="forecast",
                intervals=interval_iso,
                values=rooftop_forecast_values,
            ),
            "rooftopPvActual": _dataset(
                trading_day=trading_day,
                source_id=self.id,
                metric="rooftopPv",
                kind="actual",
                intervals=interval_iso,
                values=rooftop_actual_values,
            ),
        }
        return NormalizedDay(
            trading_date=trading_day.isoformat(),
            forecast_issued_at=issued,
            datasets=datasets,
        )


def build_normalized_day(
    trading_day: date_cls,
    adapter: SourceAdapter,
    *,
    include_actuals: bool = True,
) -> NormalizedDay:
    return adapter.build_day(trading_day, include_actuals=include_actuals)


def project_day_payload(day: NormalizedDay) -> dict:
    """Project normalized datasets to the current frontend compatibility JSON."""
    demand_fc = day.datasets["demandForecast"]
    demand_actual = day.datasets["demandActual"]
    rooftop_fc = day.datasets["rooftopPvForecast"]
    rooftop_actual = day.datasets["rooftopPvActual"]

    regions_payload: dict[str, dict] = {}
    for region in REGIONS:
        regions_payload[region] = {
            "demand": {
                "intervals": demand_fc.intervals,
                "poe10": demand_fc.values[region]["poe10"],
                "poe50": demand_fc.values[region]["poe50"],
                "poe90": demand_fc.values[region]["poe90"],
                "actual": demand_actual.values[region]["actual"],
            },
            "rooftopPv": {
                "intervals": rooftop_fc.intervals,
                "poe10": rooftop_fc.values[region]["poe10"],
                "poe50": rooftop_fc.values[region]["poe50"],
                "poe90": rooftop_fc.values[region]["poe90"],
                "actual": rooftop_actual.values[region]["actual"],
            },
        }
    return {
        "tradingDate": day.trading_date,
        "forecastIssuedAt": day.forecast_issued_at,
        "regions": regions_payload,
    }


def build_day_payload(trading_day: date_cls, source: Source) -> dict:
    normalized = build_normalized_day(trading_day, NemwebDayAdapter(source), include_actuals=True)
    return project_day_payload(normalized)


def build_today_payload(trading_day: date_cls, source: Source) -> dict:
    """Forecast-only payload for the in-progress trading day.

    Same shape as ``build_day_payload`` (so the frontend loads ``today.json``
    identically to any dated file) but with empty ``actual`` arrays: live
    actuals are layered in client-side from the Cloudflare Worker, not baked
    into the file. Only the day-ahead forecast plume is fetched.
    """
    normalized = build_normalized_day(trading_day, NemwebDayAdapter(source), include_actuals=False)
    return project_day_payload(normalized)


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


def ingest_day(trading_day: date_cls, out_dir: Path, source: Source) -> Path:
    log.info("ingesting trading day %s", trading_day.isoformat())
    payload = build_day_payload(trading_day, source)
    return write_outputs(payload, out_dir)


def write_today(payload: dict, out_dir: Path) -> Path:
    """Write today.json. Deliberately not added to index.json/latest.json:
    it is a transient pointer to the in-progress day's forecast plume."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "today.json"
    path.write_text(json.dumps(payload, separators=(",", ":")))
    return path


def ingest_today(trading_day: date_cls, out_dir: Path, source: Source) -> Path:
    log.info("writing today.json for in-progress trading day %s", trading_day.isoformat())
    payload = build_today_payload(trading_day, source)
    return write_today(payload, out_dir)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    g = p.add_mutually_exclusive_group(required=False)
    g.add_argument("--date", type=lambda s: datetime.strptime(s, "%Y-%m-%d").date(),
                   help="Trading day D (AEST), YYYY-MM-DD")
    g.add_argument("--backfill", type=int, metavar="N",
                   help="Ingest the last N days, ending yesterday (AEST)")
    p.add_argument("--today", action="store_true",
                   help="Also write today.json: the forecast plume for the in-progress "
                        "trading day (today, AEST), with empty actual arrays. Can be combined "
                        "with --date/--backfill, or used on its own.")
    p.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "public" / "data",
                   help="Output directory for JSON (default: ../public/data)")
    p.add_argument("--source", default=None,
                   help="Data source: an http(s):// base URL or a local fixture directory. "
                        "Defaults to $NEMWEB_SOURCE or the live NEMWEB site.")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    today_aest = datetime.now(AEST).date()
    if args.backfill:
        days = [today_aest - timedelta(days=i) for i in range(1, args.backfill + 1)]
    elif args.date:
        days = [args.date]
    else:
        days = []

    if not days and not args.today:
        p.error("one of --date, --backfill, or --today is required")

    source = make_source(args.source)
    log.info("source: %s", source)

    failures: list[tuple[date_cls, str]] = []
    for d in days:
        try:
            out_path = ingest_day(d, args.out, source)
            log.info("wrote %s", out_path)
        except Exception as exc:  # noqa: BLE001
            log.warning("skipped %s: %s", d.isoformat(), exc)
            failures.append((d, str(exc)))

    if days and failures and len(failures) == len(days):
        log.error("all days failed")
        return 1

    # Refresh the demand forecast-error rankings from all day files on disk, so
    # newly added days enter the top-N list when they qualify.
    try:
        from rankings import write_rankings

        rankings_path = write_rankings(args.out)
        log.info("wrote %s", rankings_path)
    except Exception as exc:  # noqa: BLE001
        log.warning("failed to update rankings: %s", exc)

    # today.json: the in-progress trading day's forecast plume (live actuals are
    # layered in client-side). Its failure never sinks a successful day ingest;
    # only a today-only run fails the process.
    today_failed = False
    if args.today:
        try:
            out_path = ingest_today(today_aest, args.out, source)
            log.info("wrote %s", out_path)
        except Exception as exc:  # noqa: BLE001
            today_failed = True
            log.warning("failed to write today.json for %s: %s", today_aest.isoformat(), exc)

    if today_failed and not days:
        return 1
    if failures:
        log.warning("%d/%d days skipped", len(failures), len(days))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
