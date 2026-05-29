"""Parser smoke tests against synthetic AEMO MMS-format CSVs.

These don't touch the network. End-to-end pipeline tests live in
`../tests/test_ingest.py`; live real-data validation is recorded in
`../FLAGS.md` and can be reproduced via the `ingest` GitHub workflow.

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
    parse_directory_listing,
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


# A real NEMWEB Apache index links files by absolute, upper-cased path and
# carries column-sort and parent-directory links that must be ignored. This
# mirrors the live markup (see https://nemweb.com.au/Reports/Current/...).
SAMPLE_INDEX_HTML = """\
<html><head><title>Index of /Reports/CURRENT/Operational_Demand/ACTUAL_HH</title></head>
<body><h1>Index of /Reports/CURRENT/Operational_Demand/ACTUAL_HH</h1>
<pre><img src="/icons/blank.gif"> <A HREF="?C=N;O=D">Name</A>
<img src="/icons/back.gif"> <A HREF="/Reports/CURRENT/Operational_Demand/">Parent Directory</A>
<img src="/icons/compressed.gif"> <A HREF="/Reports/CURRENT/Operational_Demand/ACTUAL_HH/PUBLIC_ACTUAL_OPERATIONAL_DEMAND_HH_202605280000_20260528000301.zip">PUBLIC_ACTUAL...</A>
<img src="/icons/compressed.gif"> <A HREF="/Reports/CURRENT/Operational_Demand/ACTUAL_HH/PUBLIC_ACTUAL_OPERATIONAL_DEMAND_HH_202605280030_20260528003020.zip">PUBLIC_ACTUAL...</A>
</pre></body></html>
"""


def test_parse_directory_listing_absolute_hrefs():
    base = "https://nemweb.com.au/Reports/Current/Operational_Demand/ACTUAL_HH/"
    entries = parse_directory_listing(SAMPLE_INDEX_HTML, base)
    # Only the two .zip data files; parent dir and ?C= sort link are dropped.
    assert len(entries) == 2
    e = entries[0]
    assert e.filename == "PUBLIC_ACTUAL_OPERATIONAL_DEMAND_HH_202605280000_20260528000301.zip"
    # Absolute href resolved against host (not naively appended to the dir URL).
    assert e.url == (
        "https://nemweb.com.au/Reports/CURRENT/Operational_Demand/ACTUAL_HH/"
        "PUBLIC_ACTUAL_OPERATIONAL_DEMAND_HH_202605280000_20260528000301.zip"
    )
    assert e.timestamp == datetime(2026, 5, 28, 0, 0, tzinfo=AEST)


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
