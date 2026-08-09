from __future__ import annotations

import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "forecaster_context.py"
_spec = importlib.util.spec_from_file_location("forecaster_context", _SCRIPT)
fc = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
sys.modules["forecaster_context"] = fc
_spec.loader.exec_module(fc)


def test_rooftop_area_contract_and_region_mapping():
    tables = {
        "ROOFTOP_ROOFTOP_ACTUAL": [
            {
                "AREAID": "QLDNORTH",
                "INTERVAL_DATETIME": "2026/08/09 12:30:00",
                "POWER": "456.7",
                "QI": "0.98",
                "TYPE": "SATELLITE",
            }
        ],
        "ROOFTOP_ROOFTOP_FORECAST": [
            {
                "AREAID": "QLDNORTH",
                "INTERVAL_DATETIME": "2026/08/09 13:00:00",
                "POWERMEAN": "500",
                "POWERPOE50": "510",
                "POWERPOELOW": "430",
                "POWERPOEHIGH": "580",
            }
        ],
    }
    actual = fc.parse_rooftop_area_actual(tables, "2026-08-09")
    forecast = fc.parse_rooftop_area_forecast(tables, "2026-08-09")

    assert actual["QLDNORTH"][0]["value"] == 456.7
    assert forecast["QLDNORTH"]["region"] == "QLD1"
    assert forecast["QLDNORTH"]["poe50"] == [510.0]


def test_scada_delta_and_dispatch_constraint_context():
    previous = {"duidScada": {"assets": [{"duid": "WIND1", "currentMw": 90.0}]}}
    scada = fc.parse_duid_scada(
        {
            "DISPATCH_DISPATCH_UNIT_SCADA": [
                {"DUID": "WIND1", "SETTLEMENTDATE": "2026/08/09 12:05:00", "SCADAVALUE": "145"}
            ]
        },
        {"WIND1": {"region": "SA1", "fueltech": "wind", "capacityMw": 200}},
        previous,
    )
    assert scada["assets"][0]["deltaMw"] == 55.0
    assert scada["assets"][0]["fueltech"] == "wind"

    dispatch = fc.parse_dispatch_context(
        {
            "DISPATCH_DISPATCH_REGIONSUM": [
                {
                    "INTERVENTION": "0",
                    "REGIONID": "SA1",
                    "SETTLEMENTDATE": "2026/08/09 12:05:00",
                    "TOTALDEMAND": "1800",
                    "AVAILABLEGENERATION": "3000",
                }
            ],
            "DISPATCH_DISPATCH_PRICE": [{"INTERVENTION": "0", "REGIONID": "SA1", "RRP": "125.5"}],
            "DISPATCH_DISPATCH_CONSTRAINT": [
                {
                    "INTERVENTION": "0",
                    "CONSTRAINTID": "S_TEST",
                    "RHS": "100",
                    "LHS": "100",
                    "MARGINALVALUE": "20.5",
                    "VIOLATIONDEGREE": "0",
                }
            ],
        }
    )
    assert dispatch["regions"]["SA1"]["rrp"] == 125.5
    assert dispatch["bindingConstraints"][0]["constraintId"] == "S_TEST"


def test_reserve_ramps_and_run_to_run_briefing():
    aest = timezone(timedelta(hours=10))
    now = datetime(2026, 8, 9, 12, 0, tzinfo=aest)
    reserve = fc.parse_reserve_context(
        {
            "PDPASA_PDPASA_REGIONSOLUTION": [
                {
                    "RUNTYPE": "LOR",
                    "REGIONID": "VIC1",
                    "RUN_DATETIME": "2026/08/09 12:00:00",
                    "INTERVAL_DATETIME": "2026/08/09 14:00:00",
                    "SURPLUSRESERVE": "250",
                    "MAXSPARECAPACITY": "400",
                    "LORCONDITION": "1",
                    "DEMAND50": "6000",
                    "SS_WIND_UIGF": "1000",
                    "SS_SOLAR_UIGF": "500",
                }
            ]
        },
        now,
    )
    assert reserve["regions"]["VIC1"]["worstLorCondition"] == 1

    demand = {
        "VIC1": [
            {"ts": "2026-08-09T11:30:00+10:00", "value": 5000},
            {"ts": "2026-08-09T12:00:00+10:00", "value": 5400},
        ]
    }
    metrics = fc.build_region_metrics(demand, {})
    context = {
        "updatedAt": "2026-08-09T02:00:00Z",
        "regions": metrics,
        "currentForecast": {},
        "reserve": reserve,
        "dispatch": {"bindingConstraints": []},
        "duidScada": {"assets": []},
    }
    briefing = fc.build_briefing(context, {"updatedAt": "2026-08-09T01:50:00Z"})
    types = {event["type"] for event in briefing["events"]}
    assert "demand-ramp" in types
    assert "reserve-risk" in types
    assert briefing["comparedWith"] == "2026-08-09T01:50:00Z"
    assert len(briefing["changes"]) == 2


def test_first_briefing_establishes_baseline_without_claiming_changes():
    context = {
        "updatedAt": "2026-08-09T02:00:00Z",
        "regions": {},
        "currentForecast": {},
        "reserve": {"regions": {}},
        "dispatch": {
            "bindingConstraints": [
                {"constraintId": "N_TEST", "marginalValue": 12.0, "violationDegree": 0.0}
            ]
        },
        "duidScada": {"assets": []},
    }
    briefing = fc.build_briefing(context, None)
    assert len(briefing["events"]) == 1
    assert briefing["changes"] == []
    assert briefing["summary"].startswith("Comparison baseline established")
