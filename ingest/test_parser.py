"""Parser smoke tests against synthetic AEMO MMS-format CSVs.

These don't touch the network. End-to-end pipeline tests live in
`../tests/test_ingest.py`; real-data validation happens via the `ingest`
GitHub workflow (the sandbox can't reach NEMWEB).

Run:
    uv run python -m pytest test_parser.py     (if pytest installed)
    uv run python test_parser.py                (plain runner)
"""

from __future__ import annotations

import io
import zipfile
from datetime import date, datetime

from nemweb import (
    AEST,
    parse_aemo_csv,
    parse_filename_timestamp,
    pick_snapshot_at_or_before,
    read_aemo_zip,
    DirectoryEntry,
)
from ingest import _series_for_region, half_hour_intervals


# Two-table CSV: one forecast-shaped, one ignored.
SAMPLE_FORECAST_CSV = """\
C,NEMP.WORLD,DEMAND,AEMO,PUBLIC,2026/05/27 16:00:00,12345,DEMAND,FORECAST
I,OPERATIONAL_DEMAND,FORECAST_HH,1,INTERVAL_DATETIME,REGIONID,OPERATIONAL_DEMAND_POE10,OPERATIONAL_DEMAND_POE50,OPERATIONAL_DEMAND_POE90,LOAD_DATE
D,OPERATIONAL_DEMAND,FORECAST_HH,1,"2026/05/28 00:30:00",NSW1,7600.1,7400.2,7200.3,"2026/05/27 16:00:00"
D,OPERATIONAL_DEMAND,FORECAST_HH,1,"2026/05/28 01:00:00",NSW1,7500.5,7300.6,7100.7,"2026/05/27 16:00:00"
D,OPERATIONAL_DEMAND,FORECAST_HH,1,"2026/05/28 00:30:00",VIC1,5500.0,5300.0,5100.0,"2026/05/27 16:00:00"
I,OPERATIONAL_DEMAND,JUNK,1,A,B
D,OPERATIONAL_DEMAND,JUNK,1,1,2
C,END,1
"""


def test_parse_filename_timestamp():
    assert parse_filename_timestamp("PUBLIC_FORECAST_HH_202605271600_0000000123456789.zip") == \
        datetime(2026, 5, 27, 16, 0, tzinfo=AEST)
    assert parse_filename_timestamp("PUBLIC_X_20260527160030_0.zip") == \
        datetime(2026, 5, 27, 16, 0, 30, tzinfo=AEST)
    assert parse_filename_timestamp("no_timestamp.zip") is None


def test_parse_aemo_csv_groups_by_table():
    tables = parse_aemo_csv(SAMPLE_FORECAST_CSV)
    assert "OPERATIONAL_DEMAND_FORECAST_HH" in tables
    assert "OPERATIONAL_DEMAND_JUNK" in tables
    df = tables["OPERATIONAL_DEMAND_FORECAST_HH"]
    assert list(df.columns) == [
        "INTERVAL_DATETIME", "REGIONID",
        "OPERATIONAL_DEMAND_POE10", "OPERATIONAL_DEMAND_POE50", "OPERATIONAL_DEMAND_POE90",
        "LOAD_DATE",
    ]
    assert len(df) == 3


def test_read_aemo_zip_handles_nested():
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as zf:
        zf.writestr("PUBLIC_FORECAST_202605271600.csv", SAMPLE_FORECAST_CSV)
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w") as zf:
        zf.writestr("inner.zip", inner.getvalue())
    tables = read_aemo_zip(outer.getvalue())
    assert "OPERATIONAL_DEMAND_FORECAST_HH" in tables
    assert len(tables["OPERATIONAL_DEMAND_FORECAST_HH"]) == 3


def test_series_for_region_projection():
    tables = parse_aemo_csv(SAMPLE_FORECAST_CSV)
    df = tables["OPERATIONAL_DEMAND_FORECAST_HH"]
    intervals = half_hour_intervals(date(2026, 5, 28))
    s = _series_for_region(df, "NSW1", "OPERATIONAL_DEMAND_POE50", intervals)
    assert len(s) == 48
    assert s[0] == 7400.2   # 00:30
    assert s[1] == 7300.6   # 01:00
    assert s[2] is None     # 01:30 not in fixture


def test_pick_snapshot_at_or_before():
    entries = [
        DirectoryEntry("a_202605271400.zip", "u", datetime(2026, 5, 27, 14, 0, tzinfo=AEST)),
        DirectoryEntry("a_202605271600.zip", "u", datetime(2026, 5, 27, 16, 0, tzinfo=AEST)),
        DirectoryEntry("a_202605271800.zip", "u", datetime(2026, 5, 27, 18, 0, tzinfo=AEST)),
    ]
    cutoff = datetime(2026, 5, 27, 17, 0, tzinfo=AEST)
    chosen = pick_snapshot_at_or_before(entries, cutoff)
    assert chosen is not None
    assert chosen.filename == "a_202605271600.zip"


def _run_all() -> int:
    tests = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    import sys
    sys.exit(_run_all())
