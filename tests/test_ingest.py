"""End-to-end ingest tests against the synthetic fixtures.

These run the *real* ingest pipeline (the same code path as production) via a
LocalSource pointed at ``tests/fixtures/nemweb`` — no network required. They
cover the documented edge cases: missing 16:00 forecast snapshot, a region
absent from the rooftop reports, the half-hour interval straddling midnight,
a genuinely missing actual interval, and SATELLITE rows being filtered out.

Run:
    cd ingest && uv run python -m pytest ../tests/test_ingest.py
    uv run python tests/test_ingest.py        (plain runner, no pytest needed)
"""

from __future__ import annotations

import json
import sys
import tempfile
from datetime import date
from pathlib import Path

# Make the ingest package importable regardless of where pytest is invoked.
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "ingest"))

from nemweb import LocalSource, HttpSource, make_source  # noqa: E402
from ingest import build_day_payload, build_today_payload, ingest_day  # noqa: E402

FIXTURES = _ROOT / "tests" / "fixtures" / "nemweb"
TRADING_DAY = date(2026, 5, 28)


def _payload() -> dict:
    return build_day_payload(TRADING_DAY, LocalSource(FIXTURES))


def test_payload_shape_and_issue_time():
    p = _payload()
    assert p["tradingDate"] == "2026-05-28"
    # The 16:00 snapshot is missing; the picker must fall back to 15:30 and
    # ignore the post-cutoff 18:00 snapshot.
    assert p["forecastIssuedAt"] == "2026-05-27T15:30+10:00"
    assert set(p["regions"]) == {"NSW1", "VIC1", "QLD1", "SA1", "TAS1"}


def test_intervals_straddle_midnight():
    p = _payload()
    demand = p["regions"]["NSW1"]["demand"]
    assert len(demand["intervals"]) == 48
    assert demand["intervals"][0] == "2026-05-28T00:30+10:00"
    # Last interval-ending stamp rolls over into the next calendar day.
    assert demand["intervals"][47] == "2026-05-29T00:00+10:00"
    # The actual carried by the just-after-midnight publish run is present.
    assert demand["actual"][47] is not None


def test_demand_poe_ordering_and_values():
    d = _payload()["regions"]["NSW1"]["demand"]
    assert d["poe50"][0] == 6300.0
    # POE10 (10% exceedance) is the high estimate, POE90 the low one.
    assert d["poe10"][0] > d["poe50"][0] > d["poe90"][0]
    # Realised demand tracks just below the central forecast.
    assert d["actual"][0] is not None and d["actual"][0] < d["poe50"][0]


def test_missing_actual_interval_is_null():
    d = _payload()["regions"]["NSW1"]["demand"]
    # Interval index 5 (03:30) was dropped from every actual file.
    assert d["actual"][5] is None
    # Neighbouring intervals are still populated.
    assert d["actual"][4] is not None
    assert d["actual"][6] is not None


def test_rooftop_night_zero_and_midday_peak():
    r = _payload()["regions"]["NSW1"]["rooftopPv"]
    assert r["poe50"][0] == 0.0          # 00:30, dark
    assert r["actual"][0] == 0.0
    assert r["poe50"][24] > 1000.0       # 12:30, near peak
    assert r["poe10"][24] > r["poe50"][24] > r["poe90"][24]


def test_rooftop_satellite_rows_filtered():
    r = _payload()["regions"]["NSW1"]["rooftopPv"]
    # Interval 24 has a TYPE=SATELLITE sentinel of 99999 that must be dropped
    # in favour of the MEASUREMENT row.
    assert r["actual"][24] != 99999.0
    assert r["actual"][24] is not None and r["actual"][24] < 3000.0


def test_region_absent_from_rooftop_is_all_null():
    p = _payload()
    tas = p["regions"]["TAS1"]
    # TAS1 is absent from the rooftop fixtures -> every rooftop slot is null...
    assert all(v is None for v in tas["rooftopPv"]["poe50"])
    assert all(v is None for v in tas["rooftopPv"]["actual"])
    # ...but its demand series is still populated.
    assert tas["demand"]["poe50"][0] is not None


def test_today_payload_has_forecast_but_empty_actuals():
    # today.json carries the same shape as a dated file so the frontend loads
    # it identically, but actuals are left empty (filled live from the Worker).
    p = build_today_payload(TRADING_DAY, LocalSource(FIXTURES))
    assert p["tradingDate"] == "2026-05-28"
    assert p["forecastIssuedAt"] == "2026-05-27T15:30+10:00"
    assert set(p["regions"]) == {"NSW1", "VIC1", "QLD1", "SA1", "TAS1"}
    nsw = p["regions"]["NSW1"]
    # Forecast plume is populated for both metrics...
    assert nsw["demand"]["poe50"][0] == 6300.0
    assert nsw["demand"]["poe10"][0] > nsw["demand"]["poe50"][0] > nsw["demand"]["poe90"][0]
    assert nsw["rooftopPv"]["poe50"][24] > 1000.0
    # ...but every actual slot is null, for both metrics, all 48 intervals.
    assert nsw["demand"]["actual"] == [None] * 48
    assert nsw["rooftopPv"]["actual"] == [None] * 48


def test_ingest_day_writes_outputs():
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        day_path = ingest_day(TRADING_DAY, out, LocalSource(FIXTURES))
        assert day_path.exists()
        payload = json.loads(day_path.read_text())
        assert payload["tradingDate"] == "2026-05-28"
        index = json.loads((out / "index.json").read_text())
        assert index == [{"date": "2026-05-28"}]
        latest = json.loads((out / "latest.json").read_text())
        assert latest == {"date": "2026-05-28", "path": "2026-05-28.json"}


def test_make_source_dispatch():
    assert isinstance(make_source("https://nemweb.com.au"), HttpSource)
    assert isinstance(make_source(str(FIXTURES)), LocalSource)
    assert isinstance(make_source(None, ), (HttpSource, LocalSource))


def _run_all() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
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
    sys.exit(_run_all())
