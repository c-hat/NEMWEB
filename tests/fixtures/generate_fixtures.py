"""Generate synthetic AEMO MMS-format fixtures for the NEMWEB ingest tests.

This is the single source of truth for the fixtures committed under
``tests/fixtures/nemweb/``. Re-run it to regenerate them::

    uv run python tests/fixtures/generate_fixtures.py

The fixtures mirror the live NEMWEB directory layout so ``LocalSource`` can be
pointed straight at ``tests/fixtures/nemweb`` and the real ingest pipeline runs
unchanged. Files are written as plain ``.csv`` (one MMS report each) so the
schema stays reviewable in git; ``LocalSource`` parses them with the same
``parse_aemo_csv`` used for live ``.zip`` payloads.

Modelled trading day: 2026-05-28 (AEST). Day-ahead forecast snapshots are
issued on 2026-05-27. Values are deterministic, region-scaled, and shaped to
look plausible (demand ~5,000-15,000 MW with morning/evening peaks; rooftop PV
zero overnight, peaking around midday).

The fixtures deliberately bake in the documented edge cases:
  * No 16:00 forecast snapshot exists -> the picker must fall back to 15:30.
  * A later (post-cutoff, 18:00) snapshot exists and must be ignored.
  * TAS1 is absent from the rooftop reports (stands in for "region with no
    rooftop PV") -> its rooftop series must come out all-null.
  * Demand actual is split across several publish-run files, including one
    timestamped just after midnight carrying the interval that straddles the
    day boundary (interval-ending 00:00).
  * One demand-actual interval (03:30) is missing entirely -> null in output.
  * Rooftop actual carries TYPE=SATELLITE rows that must be filtered out in
    favour of TYPE=MEASUREMENT.
"""

from __future__ import annotations

import csv
import io
import math
from datetime import datetime, timedelta
from pathlib import Path

# --- Model parameters ----------------------------------------------------

TRADING_DAY = datetime(2026, 5, 28)          # D (AEST, naive clock)
N_INTERVALS = 48                             # half-hours, ending 00:30..24:00
FIRST_INTERVAL = TRADING_DAY + timedelta(minutes=30)

# Issue clock times for the day-ahead snapshots (D-1).
ISSUE_FULL = datetime(2026, 5, 27, 15, 30)   # chosen snapshot (no 16:00 exists)
ISSUE_EARLY = datetime(2026, 5, 27, 14, 0)   # earlier, must lose to 15:30
ISSUE_LATE = datetime(2026, 5, 27, 18, 0)    # after the 17:00 cutoff, ignored

DEMAND_REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]
ROOFTOP_REGIONS = ["NSW1", "VIC1", "QLD1", "SA1"]   # TAS1 intentionally absent

# Per-region peak/base levels (MW).
DEMAND_BASE = {"NSW1": 9000, "VIC1": 6000, "QLD1": 7000, "SA1": 1500, "TAS1": 1100}
ROOFTOP_PEAK = {"NSW1": 2800, "VIC1": 1600, "QLD1": 2600, "SA1": 1300}

MISSING_ACTUAL_INTERVAL = 5     # interval index 5 == 03:30; dropped from actuals
SATELLITE_INTERVAL = 24         # interval index 24 == 12:30; gets a SATELLITE row

# NEMWEB-style report roots, relative to the fixture base.
PATH_DEMAND_FORECAST = "Reports/Current/Operational_Demand/FORECAST_HH"
PATH_DEMAND_ACTUAL = "Reports/Current/Operational_Demand/ACTUAL_HH"
PATH_ROOFTOP_FORECAST = "Reports/Current/ROOFTOP_PV/FORECAST"
PATH_ROOFTOP_ACTUAL = "Reports/Current/ROOFTOP_PV/ACTUAL"


# --- Time helpers --------------------------------------------------------

def interval_dt(i: int) -> datetime:
    """Interval-ending timestamp for index i (0 -> 00:30 ... 47 -> next 00:00)."""
    return FIRST_INTERVAL + timedelta(minutes=30 * i)


def interval_hour(i: int) -> float:
    """Decimal interval-ending hour-of-day (0.5 .. 24.0)."""
    return 0.5 * (i + 1)


def aemo_dt(dt: datetime) -> str:
    return dt.strftime("%Y/%m/%d %H:%M:%S")


def file_ts(dt: datetime) -> str:
    return dt.strftime("%Y%m%d%H%M%S")


# --- Value shaping (deterministic) --------------------------------------

def _demand_shape(hour: float) -> float:
    """0.7 overnight up to ~1.0 at the morning/evening peaks."""
    morning = math.exp(-((hour - 8.0) ** 2) / (2 * 1.5 ** 2))
    evening = math.exp(-((hour - 18.5) ** 2) / (2 * 1.8 ** 2))
    return 0.70 + 0.30 * max(morning, evening)


def _pv_shape(hour: float) -> float:
    """Zero outside ~06:00-19:00, bell peaking at 12:30."""
    if hour < 6.0 or hour > 19.0:
        return 0.0
    return math.exp(-((hour - 12.5) ** 2) / (2 * 3.0 ** 2))


def demand_poe50(region: str, i: int) -> float:
    return round(DEMAND_BASE[region] * _demand_shape(interval_hour(i)), 1)


def demand_actual(region: str, i: int) -> float:
    # Realised demand sits a touch below the central forecast.
    return round(demand_poe50(region, i) * 0.99, 1)


def rooftop_poe50(region: str, i: int) -> float:
    return round(ROOFTOP_PEAK[region] * _pv_shape(interval_hour(i)), 1)


def rooftop_actual(region: str, i: int) -> float:
    return round(rooftop_poe50(region, i) * 0.97, 1)


# --- CSV writing ---------------------------------------------------------

def _write_mms_csv(
    path: Path,
    report_type: str,
    table_name: str,
    version: int,
    columns: list[str],
    rows: list[list],
    issued: datetime,
) -> None:
    """Write one AEMO MMS report (C/I/D/C) to path."""
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["C", "NEMP.WORLD", report_type, "AEMO", "PUBLIC", aemo_dt(issued), "0000000001",
                report_type, table_name])
    w.writerow(["I", report_type, table_name, version, *columns])
    for r in rows:
        w.writerow(["D", report_type, table_name, version, *r])
    w.writerow(["C", "END OF REPORT", len(rows) + 1])
    path.write_text(buf.getvalue())


def _clear_dir(d: Path) -> None:
    if d.is_dir():
        for p in d.glob("*.csv"):
            p.unlink()


# --- Generators per report ----------------------------------------------

def _demand_forecast_rows(regions: list[str], indices: list[int], issued: datetime) -> list[list]:
    rows = []
    for i in indices:
        for region in regions:
            p50 = demand_poe50(region, i)
            rows.append([
                aemo_dt(issued), region, aemo_dt(interval_dt(i)),
                round(p50 * 1.06, 1),   # POE10: 10% chance of exceedance -> higher
                p50,                    # POE50: central
                round(p50 * 0.94, 1),   # POE90: lower
                aemo_dt(issued),
            ])
    return rows


DEMAND_FORECAST_COLS = [
    "RUN_DATETIME", "REGIONID", "INTERVAL_DATETIME",
    "OPERATIONAL_DEMAND_POE10", "OPERATIONAL_DEMAND_POE50", "OPERATIONAL_DEMAND_POE90",
    "LASTCHANGED",
]
DEMAND_ACTUAL_COLS = ["INTERVAL_DATETIME", "REGIONID", "OPERATIONAL_DEMAND", "LASTCHANGED"]
ROOFTOP_FORECAST_COLS = [
    "VERSION_DATETIME", "REGIONID", "INTERVAL_DATETIME",
    "POWERMEAN", "POWERPOE50", "POWERPOELOW", "POWERPOEHIGH", "LASTCHANGED",
]
ROOFTOP_ACTUAL_COLS = ["INTERVAL_DATETIME", "REGIONID", "POWER", "QI", "TYPE", "LASTCHANGED"]


def generate(base: Path) -> None:
    base = Path(base)
    for rel in (PATH_DEMAND_FORECAST, PATH_DEMAND_ACTUAL, PATH_ROOFTOP_FORECAST, PATH_ROOFTOP_ACTUAL):
        _clear_dir(base / rel)

    all_idx = list(range(N_INTERVALS))

    # --- Demand forecast: full 15:30 snapshot (chosen), plus decoys ------
    _write_mms_csv(
        base / PATH_DEMAND_FORECAST /
        f"PUBLIC_OPERATIONAL_DEMAND_FORECAST_HH_{file_ts(ISSUE_FULL)}_0000000001.csv",
        "OPERATIONAL_DEMAND", "FORECAST_HH", 1, DEMAND_FORECAST_COLS,
        _demand_forecast_rows(DEMAND_REGIONS, all_idx, ISSUE_FULL), ISSUE_FULL,
    )
    # Earlier snapshot (must lose the at-or-before pick to 15:30): sparse.
    _write_mms_csv(
        base / PATH_DEMAND_FORECAST /
        f"PUBLIC_OPERATIONAL_DEMAND_FORECAST_HH_{file_ts(ISSUE_EARLY)}_0000000002.csv",
        "OPERATIONAL_DEMAND", "FORECAST_HH", 1, DEMAND_FORECAST_COLS,
        _demand_forecast_rows(["NSW1"], [0, 1], ISSUE_EARLY), ISSUE_EARLY,
    )
    # Later snapshot, after the 17:00 cutoff (must be ignored): sparse.
    _write_mms_csv(
        base / PATH_DEMAND_FORECAST /
        f"PUBLIC_OPERATIONAL_DEMAND_FORECAST_HH_{file_ts(ISSUE_LATE)}_0000000003.csv",
        "OPERATIONAL_DEMAND", "FORECAST_HH", 1, DEMAND_FORECAST_COLS,
        _demand_forecast_rows(["NSW1"], [0, 1], ISSUE_LATE), ISSUE_LATE,
    )

    # --- Demand actual: split across publish runs through the day --------
    chunks = [all_idx[k:k + 8] for k in range(0, N_INTERVALS, 8)]
    for seq, chunk in enumerate(chunks, start=1):
        rows = []
        for i in chunk:
            if i == MISSING_ACTUAL_INTERVAL:
                continue  # leave a genuine gap -> null in the output
            for region in DEMAND_REGIONS:
                rows.append([
                    aemo_dt(interval_dt(i)), region, demand_actual(region, i),
                    aemo_dt(interval_dt(i)),
                ])
        # Publish-run timestamp: ~5 min after the chunk's last interval.
        run_ts = interval_dt(chunk[-1]) + timedelta(minutes=5)
        _write_mms_csv(
            base / PATH_DEMAND_ACTUAL /
            f"PUBLIC_OPERATIONAL_DEMAND_ACTUAL_HH_{file_ts(run_ts)}_{seq:010d}.csv",
            "OPERATIONAL_DEMAND", "ACTUAL_HH", 1, DEMAND_ACTUAL_COLS, rows, run_ts,
        )

    # --- Rooftop forecast: full 15:30 snapshot, plus a post-cutoff decoy -
    rooftop_fc_rows = []
    for i in all_idx:
        for region in ROOFTOP_REGIONS:
            p50 = rooftop_poe50(region, i)
            rooftop_fc_rows.append([
                aemo_dt(ISSUE_FULL), region, aemo_dt(interval_dt(i)),
                p50,                    # POWERMEAN
                p50,                    # POWERPOE50
                round(p50 * 0.85, 1),   # POWERPOELOW
                round(p50 * 1.12, 1),   # POWERPOEHIGH
                aemo_dt(ISSUE_FULL),
            ])
    _write_mms_csv(
        base / PATH_ROOFTOP_FORECAST /
        f"PUBLIC_ROOFTOP_PV_FORECAST_{file_ts(ISSUE_FULL)}_0000000001.csv",
        "ROOFTOP", "FORECAST", 2, ROOFTOP_FORECAST_COLS, rooftop_fc_rows, ISSUE_FULL,
    )
    _write_mms_csv(
        base / PATH_ROOFTOP_FORECAST /
        f"PUBLIC_ROOFTOP_PV_FORECAST_{file_ts(ISSUE_LATE)}_0000000002.csv",
        "ROOFTOP", "FORECAST", 2, ROOFTOP_FORECAST_COLS,
        rooftop_fc_rows[:4], ISSUE_LATE,
    )

    # --- Rooftop actual: split across runs; one SATELLITE decoy row ------
    for seq, chunk in enumerate(chunks, start=1):
        rows = []
        for i in chunk:
            for region in ROOFTOP_REGIONS:
                rows.append([
                    aemo_dt(interval_dt(i)), region, rooftop_actual(region, i),
                    1, "MEASUREMENT", aemo_dt(interval_dt(i)),
                ])
                if i == SATELLITE_INTERVAL:
                    # Sentinel SATELLITE value that must be filtered out.
                    rows.append([
                        aemo_dt(interval_dt(i)), region, 99999.0,
                        1, "SATELLITE", aemo_dt(interval_dt(i)),
                    ])
        run_ts = interval_dt(chunk[-1]) + timedelta(minutes=5)
        _write_mms_csv(
            base / PATH_ROOFTOP_ACTUAL /
            f"PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_{file_ts(run_ts)}_{seq:010d}.csv",
            "ROOFTOP", "ACTUAL", 2, ROOFTOP_ACTUAL_COLS, rows, run_ts,
        )


if __name__ == "__main__":
    out = Path(__file__).resolve().parent / "nemweb"
    generate(out)
    n = len(list(out.rglob("*.csv")))
    print(f"wrote {n} fixture CSVs under {out}")
