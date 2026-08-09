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
import hashlib
from datetime import date, datetime
from pathlib import Path

# Make the ingest package importable regardless of where pytest is invoked.
_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "ingest"))

from nemweb import AEST, LocalSource, HttpSource, make_source  # noqa: E402
from nemweb import DirectoryEntry  # noqa: E402
from dataset_contracts import NormalizedDay  # noqa: E402
from ingest import (  # noqa: E402
    NemwebDayAdapter,
    SourceDataUnavailable,
    _forecast_cutoff,
    _interval_grid,
    _region_blocks,
    build_day_payload,
    build_normalized_day,
    build_today_payload,
    fetch_demand_actual,
    fetch_demand_forecast,
    fetch_rooftop_actual,
    fetch_rooftop_forecast,
    ingest_day,
    project_day_payload,
)

FIXTURES = _ROOT / "tests" / "fixtures" / "nemweb"
TRADING_DAY = date(2026, 5, 28)
EXPECTED_DAY_SHA256 = "2be9f8ff255d0011332e3a5a8d88fa1759aab5074689c32fce799b034409b115"


def _payload() -> dict:
    return build_day_payload(TRADING_DAY, LocalSource(FIXTURES))


def test_payload_shape_and_issue_time():
    p = _payload()
    assert p["tradingDate"] == "2026-05-28"
    # The 16:00 snapshot is missing; the picker must fall back to 15:30 and
    # ignore the post-cutoff 18:00 snapshot.
    assert p["forecastIssuedAt"] == "2026-05-27T15:30+10:00"
    assert set(p["regions"]) == {"NSW1", "VIC1", "QLD1", "SA1", "TAS1"}


def test_current_day_ahead_cutoff_is_17_aest():
    assert _forecast_cutoff(TRADING_DAY) == datetime(2026, 5, 27, 17, 0, tzinfo=AEST)


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


def test_normalized_projection_matches_legacy_payload_bytes():
    source = LocalSource(FIXTURES)
    intervals, interval_iso = _interval_grid(TRADING_DAY)
    demand_fc, demand_fc_entry = fetch_demand_forecast(TRADING_DAY, source)
    demand_actual = fetch_demand_actual(TRADING_DAY, source)
    rooftop_fc, _ = fetch_rooftop_forecast(TRADING_DAY, source)
    rooftop_actual = fetch_rooftop_actual(TRADING_DAY, source)
    issued = demand_fc_entry.timestamp.strftime("%Y-%m-%dT%H:%M%z").replace("+1000", "+10:00")
    legacy_payload = {
        "tradingDate": TRADING_DAY.isoformat(),
        "forecastIssuedAt": issued,
        "regions": _region_blocks(
            demand_fc, rooftop_fc, demand_actual, rooftop_actual, intervals, interval_iso
        ),
    }

    normalized = build_normalized_day(TRADING_DAY, NemwebDayAdapter(source))
    projected = project_day_payload(normalized)

    assert json.dumps(projected, separators=(",", ":")) == json.dumps(
        legacy_payload, separators=(",", ":")
    )
    assert list(projected) == ["tradingDate", "forecastIssuedAt", "regions"]
    assert list(projected["regions"]) == ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]
    assert list(projected["regions"]["NSW1"]["demand"]) == [
        "intervals", "poe10", "poe50", "poe90", "actual"
    ]


def test_compatibility_payload_matches_pinned_fixture_hash():
    compact = json.dumps(_payload(), separators=(",", ":"))
    assert len(compact) == 24460
    assert hashlib.sha256(compact.encode()).hexdigest() == EXPECTED_DAY_SHA256


def test_normalized_dataset_metadata_is_source_agnostic():
    normalized = build_normalized_day(TRADING_DAY, NemwebDayAdapter(LocalSource(FIXTURES)))
    assert normalized.trading_date == "2026-05-28"
    demand = normalized.datasets["demandForecast"]
    assert demand.id == "aemo-nemweb.demand.forecast.2026-05-28"
    assert demand.metric == "demand"
    assert demand.kind == "forecast"
    assert demand.cadence == "30m"
    assert demand.units == "MW"
    assert demand.interval_timezone == "AEST+10:00"
    assert demand.regions == ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]


def test_source_adapter_can_be_stubbed_without_nemweb_code():
    class StubAdapter:
        id = "stub"

        def build_day(self, trading_day: date, include_actuals: bool = True) -> NormalizedDay:
            return NormalizedDay(
                trading_date=trading_day.isoformat(),
                forecast_issued_at="2026-05-27T17:00+10:00",
                datasets={},
            )

    normalized = build_normalized_day(TRADING_DAY, StubAdapter())
    assert normalized.trading_date == "2026-05-28"


def test_current_rolloff_is_explicit(tmp_path):
    empty_source = LocalSource(tmp_path)
    try:
        build_day_payload(TRADING_DAY, empty_source)
    except SourceDataUnavailable as exc:
        assert "Reports/Current may have rolled off" in str(exc)
        assert exc.archive_hint is True
    else:  # pragma: no cover - defensive
        raise AssertionError("expected SourceDataUnavailable")


def test_non_empty_current_rolloff_is_explicit():
    class FutureOnlySource:
        def list_directory(self, rel_path: str) -> list[DirectoryEntry]:
            return [
                DirectoryEntry(
                    "future_202606010000.zip",
                    "unused",
                    datetime(2026, 6, 1, 0, 0, tzinfo=AEST),
                )
            ]

        def read_tables(self, entry: DirectoryEntry) -> dict:
            raise AssertionError("read_tables should not run")

    try:
        build_day_payload(TRADING_DAY, FutureOnlySource())
    except SourceDataUnavailable as exc:
        assert "Reports/Current may have rolled off" in str(exc)
        assert exc.archive_hint is True
    else:  # pragma: no cover - defensive
        raise AssertionError("expected SourceDataUnavailable")


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
