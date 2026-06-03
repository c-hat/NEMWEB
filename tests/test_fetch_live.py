"""Logic tests for scripts/fetch_live.py (no network).

Exercises the pure parse/merge functions against synthetic OE-shaped responses,
so the multi-region parsing, the energy->MW conversion, rooftop smoothing, the
NEM summation and rooftop carry-forward are verified without an API key.

Runs under pytest (CI) and also directly: ``python3 tests/test_fetch_live.py``.
"""

from __future__ import annotations

import importlib.util
import json
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
