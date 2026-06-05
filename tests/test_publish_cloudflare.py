from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "publish_cloudflare.py"
_spec = importlib.util.spec_from_file_location("publish_cloudflare", _SCRIPT)
pc = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
sys.modules["publish_cloudflare"] = pc
_spec.loader.exec_module(pc)


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def _day(date: str) -> dict:
    return {
        "tradingDate": date,
        "forecastIssuedAt": f"{date}T17:00+10:00",
        "regions": {
            "NSW1": {
                "demand": {
                    "intervals": [f"{date}T00:30+10:00"],
                    "poe10": [1],
                    "poe50": [1],
                    "poe90": [1],
                    "actual": [1],
                },
                "rooftopPv": {
                    "intervals": [f"{date}T00:30+10:00"],
                    "poe10": [1],
                    "poe50": [1],
                    "poe90": [1],
                    "actual": [1],
                },
            }
        },
    }


def test_publish_plan_maps_compatibility_objects_and_catalog_sql(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _write_json(data_dir / "index.json", [{"date": "2026-06-03"}, {"date": "2026-06-04"}])
    _write_json(data_dir / "latest.json", {"date": "2026-06-04", "path": "2026-06-04.json"})
    _write_json(data_dir / "2026-06-03.json", _day("2026-06-03"))
    _write_json(data_dir / "2026-06-04.json", _day("2026-06-04"))
    _write_json(data_dir / "today.json", _day("2026-06-05"))
    _write_json(
        data_dir / "demand-error-rankings.json",
        {
            "metric": "daily_mean_abs_demand_error_mw",
            "topN": 15,
            "regions": {"NEM": []},
        },
    )

    plan = pc.create_plan(data_dir, "2026-06-05T00:00:00Z", tmp_path)
    keys = {upload.key for upload in plan.uploads}

    assert "compat/index.json" in keys
    assert "compat/latest.json" in keys
    assert "compat/day/2026-06-03.json" in keys
    assert "compat/day/2026-06-04.json" in keys
    assert "compat/today.json" in keys
    assert "compat/day/2026-06-05.json" in keys
    assert "compat/demand-error-rankings.json" in keys
    assert "analysis/demand-forecast-error-ranking/1.0.0.json" in keys

    assert plan.today == "2026-06-05"
    assert plan.analysis_payload["id"] == "demand-forecast-error-ranking"
    assert "INSERT INTO datasets" in plan.sql
    assert "aemo-nemweb.demand.forecast" in plan.sql
    assert "compat/day/2026-06-05.json" in plan.sql
    assert "'partial'" in plan.sql
    assert "INSERT INTO analysis_availability" in plan.sql


def test_only_live_plan_uploads_no_d1_sql(tmp_path):
    live = tmp_path / "today-live.json"
    _write_json(live, {"updatedAt": "2026-06-05T12:00:00+10:00", "regions": {}})

    plan = pc.create_plan(tmp_path / "missing-data-dir", "2026-06-05T00:00:00Z", tmp_path, live, True)

    assert [(upload.source, upload.key) for upload in plan.uploads] == [(live, "compat/live.json")]
    assert plan.sql == ""
