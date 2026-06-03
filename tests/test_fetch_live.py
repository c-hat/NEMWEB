"""Logic tests for scripts/fetch_live.py (no network).

Exercises the pure parse/merge functions against synthetic OE-shaped responses,
so the multi-region parsing, the energy->MW conversion, rooftop smoothing, the
NEM summation and rooftop carry-forward are verified without an API key.

Runs under pytest (CI) and also directly: ``python3 tests/test_fetch_live.py``.
"""

from __future__ import annotations

import importlib.util
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch_live.py"
_spec = importlib.util.spec_from_file_location("fetch_live", _SCRIPT)
fl = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(fl)


def _demand_body() -> dict:
    """Two 5-min demand intervals for all five regions, in one grouped response."""
    base = {"NSW1": 7000.0, "VIC1": 5000.0, "QLD1": 6000.0, "SA1": 1500.0, "TAS1": 1100.0}
    results = []
    for region, v in base.items():
        results.append(
            {
                "name": f"demand_{region}",
                "columns": {"network_region": region},
                "data": [
                    ["2026-06-03T00:00:00+10:00", v],
                    ["2026-06-03T00:05:00+10:00", v + 10],
                ],
            }
        )
    return {"data": [{"results": results}]}


def _rooftop_body() -> dict:
    """Rooftop energy (MWh/5min) for NSW1 only: held at 100 then stepping to 130."""
    return {
        "data": [
            {
                "results": [
                    {
                        "name": "energy_solar_rooftop_NSW1",
                        "columns": {"network_region": "NSW1", "fueltech": "solar_rooftop"},
                        "data": [
                            ["2026-06-03T09:00:00+10:00", 100.0],
                            ["2026-06-03T09:05:00+10:00", 100.0],
                            ["2026-06-03T09:30:00+10:00", 130.0],
                        ],
                    }
                ]
            }
        ]
    }


def test_parse_regions_demand():
    demand = fl.parse_regions(_demand_body())
    assert set(demand) == set(fl.REGIONS)
    assert [p["value"] for p in demand["NSW1"]] == [7000.0, 7010.0]
    # Timestamps are normalised to AEST +10:00.
    assert demand["NSW1"][0]["ts"] == "2026-06-03T00:00:00+10:00"


def test_region_of_handles_varied_shapes():
    assert fl._region_of({"columns": {"network_region_id": "QLD1"}}) == "QLD1"
    assert fl._region_of({"name": "demand_SA1", "columns": {}}) == "SA1"
    assert fl._region_of({"columns": {"unit": "MW"}, "name": "mystery"}) is None


def test_to_aest_iso_normalises():
    assert fl._to_aest_iso("2026-06-03T00:05:00") == "2026-06-03T00:05:00+10:00"  # naive -> AEST
    assert fl._to_aest_iso("2026-06-02T14:05:00Z") == "2026-06-03T00:05:00+10:00"  # UTC -> AEST
    assert fl._to_aest_iso("2026-06-03T00:05:00+10:00") == "2026-06-03T00:05:00+10:00"


def test_build_rooftop_converts_and_smooths():
    rooftop = fl.build_rooftop(_rooftop_body())
    pts = {p["ts"]: p["value"] for p in rooftop["NSW1"]}
    # MWh/5min * 12 -> average MW.
    assert pts["2026-06-03T09:00:00+10:00"] == 1200.0
    assert pts["2026-06-03T09:30:00+10:00"] == 1560.0
    # 09:05 is interpolated between the 09:00 and 09:30 anchors (not held flat).
    assert pts["2026-06-03T09:05:00+10:00"] == 1260.0


def test_sum_nem_sums_and_propagates_null():
    a = [{"ts": "t1", "value": 10.0}, {"ts": "t2", "value": 5.0}]
    b = [{"ts": "t1", "value": 1.0}, {"ts": "t2", "value": None}]
    summed = {p["ts"]: p["value"] for p in fl.sum_nem([a, b])}
    assert summed["t1"] == 11.0
    assert summed["t2"] is None


def test_assemble_includes_nem_and_rounds():
    demand = fl.parse_regions(_demand_body())
    out = fl.assemble("2026-06-03T00:10:00Z", demand, {})
    assert set(out["regions"]) == set(fl.REGIONS) | {"NEM"}
    assert out["updatedAt"] == "2026-06-03T00:10:00Z"
    # NEM demand at 00:00 = sum of the five regions' 00:00 values.
    nem0 = out["regions"]["NEM"]["demand"][0]["value"]
    assert nem0 == 7000.0 + 5000.0 + 6000.0 + 1500.0 + 1100.0
    # Empty rooftop input -> empty NEM rooftop series.
    assert out["regions"]["NEM"]["rooftopPv"] == []
    # forecasts key always present (empty when not supplied).
    assert out["forecasts"] == []


def test_assemble_includes_forecasts():
    demand = fl.parse_regions(_demand_body())
    fc = [{"issuedAt": "2026-06-03T10:30+10:00", "regions": {}}]
    out = fl.assemble("2026-06-03T00:10:00Z", demand, {}, fc)
    assert out["forecasts"] == fc


def test_carry_forward_filters_to_today(tmp_path):
    prev = {
        "updatedAt": "2026-06-03T00:00:00Z",
        "regions": {
            "NSW1": {
                "demand": [],
                "rooftopPv": [
                    {"ts": "2026-06-02T17:00:00+10:00", "value": 500.0},  # yesterday: dropped
                    {"ts": "2026-06-03T09:00:00+10:00", "value": 800.0},  # today: kept
                ],
            }
        },
    }
    prev_path = tmp_path / "prev-live.json"
    prev_path.write_text(json.dumps(prev))
    carried = fl.carry_forward_rooftop(prev_path, "2026-06-03")
    assert [p["value"] for p in carried["NSW1"]] == [800.0]
    # No file -> empty (first run).
    assert fl.carry_forward_rooftop(tmp_path / "missing.json", "2026-06-03") == {}


def test_want_rooftop_gate():
    assert fl._want_rooftop(0, False) is True
    assert fl._want_rooftop(5, False) is True
    assert fl._want_rooftop(35, False) is True
    assert fl._want_rooftop(15, False) is False
    assert fl._want_rooftop(45, False) is False
    assert fl._want_rooftop(15, True) is True  # forced overrides the gate


def test_parse_file_ts():
    assert fl._parse_file_ts("PUBLIC_OPERATIONAL_DEMAND_FORECAST_HH_20260603103000_0000000001.zip") == \
        datetime(2026, 6, 3, 10, 30, 0, tzinfo=timezone(timedelta(hours=10)))
    assert fl._parse_file_ts("PUBLIC_ROOFTOP_PV_FORECAST_202606031030_0000000002.zip") == \
        datetime(2026, 6, 3, 10, 30, 0, tzinfo=timezone(timedelta(hours=10)))
    assert fl._parse_file_ts("no_timestamp_here.zip") is None


def test_parse_aemo_mms_basic():
    csv_text = (
        "C,NEMP.WORLD,OPERATIONAL_DEMAND,AEMO,PUBLIC,2026/06/03 10:30:00\n"
        "I,OPERATIONAL_DEMAND,FORECAST_HH,1,RUN_DATETIME,REGIONID,INTERVAL_DATETIME,"
        "OPERATIONAL_DEMAND_POE10,OPERATIONAL_DEMAND_POE50,OPERATIONAL_DEMAND_POE90,LASTCHANGED\n"
        "D,OPERATIONAL_DEMAND,FORECAST_HH,1,2026/06/03 10:30:00,NSW1,2026/06/03 11:00:00,"
        "7500.0,7000.0,6500.0,2026/06/03 10:30:00\n"
        "D,OPERATIONAL_DEMAND,FORECAST_HH,1,2026/06/03 10:30:00,VIC1,2026/06/03 11:00:00,"
        "5500.0,5000.0,4500.0,2026/06/03 10:30:00\n"
    )
    tables = fl._parse_aemo_mms(csv_text)
    assert "OPERATIONAL_DEMAND_FORECAST_HH" in tables
    headers, rows = tables["OPERATIONAL_DEMAND_FORECAST_HH"]
    assert "REGIONID" in headers
    assert len(rows) == 2
    col = {h: i for i, h in enumerate(headers)}
    assert rows[0][col["REGIONID"]] == "NSW1"
    assert rows[0][col["OPERATIONAL_DEMAND_POE50"]] == "7000.0"


def _make_demand_csv(today: str = "2026/06/03") -> str:
    """Build a minimal AEMO demand forecast CSV for two regions and two intervals."""
    lines = [
        f"C,NEMP.WORLD,OPERATIONAL_DEMAND,AEMO,PUBLIC,{today} 10:30:00",
        "I,OPERATIONAL_DEMAND,FORECAST_HH,1,RUN_DATETIME,REGIONID,INTERVAL_DATETIME,"
        "OPERATIONAL_DEMAND_POE10,OPERATIONAL_DEMAND_POE50,OPERATIONAL_DEMAND_POE90,LASTCHANGED",
    ]
    for region, base in [("NSW1", 7000), ("VIC1", 5000)]:
        for t in ["11:00:00", "11:30:00"]:
            lines.append(
                f"D,OPERATIONAL_DEMAND,FORECAST_HH,1,{today} 10:30:00,{region},{today} {t},"
                f"{base + 500},{base},{base - 500},{today} 10:30:00"
            )
    return "\n".join(lines)


def _make_rooftop_csv(today: str = "2026/06/03") -> str:
    lines = [
        f"C,NEMP.WORLD,ROOFTOP,AEMO,PUBLIC,{today} 10:30:00",
        "I,ROOFTOP,FORECAST,2,VERSION_DATETIME,REGIONID,INTERVAL_DATETIME,"
        "POWERMEAN,POWERPOE50,POWERPOELOW,POWERPOEHIGH,LASTCHANGED",
    ]
    for region, base in [("NSW1", 800), ("VIC1", 400)]:
        for t in ["11:00:00", "11:30:00"]:
            lines.append(
                f"D,ROOFTOP,FORECAST,2,{today} 10:30:00,{region},{today} {t},"
                f"{base},{base},{base - 100},{base + 100},{today} 10:30:00"
            )
    return "\n".join(lines)


def test_demand_series_extracts_today_only():
    AEST = timezone(timedelta(hours=10))
    today = datetime(2026, 6, 3, 0, 0, tzinfo=AEST)
    window_start = today + timedelta(minutes=30)
    window_end = today + timedelta(days=1)

    tables = fl._parse_aemo_mms(_make_demand_csv())
    result = fl._demand_series(tables, window_start, window_end)

    assert "NSW1" in result
    assert "VIC1" in result
    assert result["NSW1"]["intervals"] == ["2026-06-03T11:00+10:00", "2026-06-03T11:30+10:00"]
    assert result["NSW1"]["poe50"] == [7000.0, 7000.0]
    assert result["NSW1"]["poe10"] == [7500.0, 7500.0]
    assert result["NSW1"]["poe90"] == [6500.0, 6500.0]
    # Regions not in the fixture are absent.
    assert "QLD1" not in result


def test_rooftop_series_poe_convention():
    AEST = timezone(timedelta(hours=10))
    today = datetime(2026, 6, 3, 0, 0, tzinfo=AEST)
    window_start = today + timedelta(minutes=30)
    window_end = today + timedelta(days=1)

    tables = fl._parse_aemo_mms(_make_rooftop_csv())
    result = fl._rooftop_series(tables, window_start, window_end)

    assert "NSW1" in result
    # poe10 = POWERPOEHIGH, poe90 = POWERPOELOW (same convention as ingest.py).
    assert result["NSW1"]["poe10"] == [900.0, 900.0]
    assert result["NSW1"]["poe50"] == [800.0, 800.0]
    assert result["NSW1"]["poe90"] == [700.0, 700.0]


def test_demand_series_rejects_out_of_window():
    AEST = timezone(timedelta(hours=10))
    # Window for tomorrow: intervals from today should not appear.
    tomorrow = datetime(2026, 6, 4, 0, 0, tzinfo=AEST)
    window_start = tomorrow + timedelta(minutes=30)
    window_end = tomorrow + timedelta(days=1)

    tables = fl._parse_aemo_mms(_make_demand_csv("2026/06/03"))
    result = fl._demand_series(tables, window_start, window_end)
    assert result == {}


def test_carry_forward_forecasts_filters_today(tmp_path):
    prev = {
        "updatedAt": "2026-06-03T00:00:00Z",
        "regions": {},
        "forecasts": [
            {"issuedAt": "2026-06-02T22:30+10:00", "regions": {}},  # yesterday
            {"issuedAt": "2026-06-03T00:30+10:00", "regions": {}},  # today
            {"issuedAt": "2026-06-03T10:30+10:00", "regions": {}},  # today
        ],
    }
    prev_path = tmp_path / "prev-live.json"
    prev_path.write_text(json.dumps(prev))
    kept = fl.carry_forward_forecasts(prev_path, "2026-06-03")
    assert len(kept) == 2
    assert all(f["issuedAt"].startswith("2026-06-03") for f in kept)
    # Missing file -> empty list.
    assert fl.carry_forward_forecasts(tmp_path / "missing.json", "2026-06-03") == []


def _run_all() -> int:
    import tempfile

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            if "tmp_path" in t.__code__.co_varnames[: t.__code__.co_argcount]:
                with tempfile.TemporaryDirectory() as d:
                    t(Path(d))
            else:
                t()
            print(f"ok   {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {t.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"ERROR {t.__name__}: {exc!r}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
