from __future__ import annotations

import json
import sys
import tempfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ingest"))

from analysis.registry import (  # noqa: E402
    ANALYSIS_DEFINITIONS,
    band_breach_payload,
    compatibility_rankings,
    forecast_error_ranking_payload,
    regional_contribution_payload,
)
from ingest import NemwebDayAdapter, build_day_payload, build_normalized_day  # noqa: E402
from nemweb import LocalSource  # noqa: E402
from rankings import compute_rankings, write_rankings  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures" / "nemweb"
TRADING_DAY = date(2026, 5, 28)
GENERATED_AT = "2026-06-05T00:00:00Z"


def _normalized():
    return build_normalized_day(TRADING_DAY, NemwebDayAdapter(LocalSource(FIXTURES)))


def test_registry_descriptors_are_versioned():
    descriptor = ANALYSIS_DEFINITIONS["demand-forecast-error-ranking"].descriptor(
        updated_at=GENERATED_AT
    )
    assert descriptor["id"] == "demand-forecast-error-ranking"
    assert descriptor["type"] == "forecast-error-ranking"
    assert descriptor["version"] == "1.0.0"
    assert descriptor["updatedAt"] == GENERATED_AT


def test_forecast_error_ranking_payload_and_compat_projection():
    payload = forecast_error_ranking_payload([_normalized()], top_n=3, generated_at=GENERATED_AT)
    compat = compatibility_rankings(payload)

    assert payload["id"] == "demand-forecast-error-ranking"
    assert payload["type"] == "forecast-error-ranking"
    assert payload["generatedAt"] == GENERATED_AT
    assert compat["topN"] == 3
    assert compat["regions"]["NSW1"][0]["date"] == "2026-05-28"
    assert compat["regions"]["NEM"][0]["intervals"] == 47


def test_ingest_ranking_writer_uses_analysis_compatibility_projection():
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        payload = build_day_payload(TRADING_DAY, LocalSource(FIXTURES))
        (out / "2026-05-28.json").write_text(json.dumps(payload, separators=(",", ":")))

        rankings = compute_rankings(out, top_n=5)
        written = write_rankings(out, top_n=5)

        assert json.loads(written.read_text()) == rankings
        assert rankings["regions"]["NSW1"][0]["date"] == "2026-05-28"


def test_band_breach_detects_outside_intervals_and_skips_nulls():
    day = _normalized()
    day.datasets["demandActual"].values["NSW1"]["actual"][0] = (
        day.datasets["demandForecast"].values["NSW1"]["poe10"][0] + 1
    )
    day.datasets["demandActual"].values["NSW1"]["actual"][1] = None

    payload = band_breach_payload(day, generated_at=GENERATED_AT)
    breaches = payload["data"]["regions"]["NSW1"]

    assert breaches == [
        {
            "interval": "2026-05-28T00:30+10:00",
            "actual": 6679.0,
            "poe10": 6678.0,
            "poe90": 5922.0,
            "direction": "above",
        }
    ]


def test_regional_contribution_sums_shares_and_propagates_missing_totals():
    payload = regional_contribution_payload(_normalized(), generated_at=GENERATED_AT)
    intervals = payload["data"]["intervals"]

    first_shares = intervals[0]["shares"]
    assert round(sum(first_shares.values()), 6) == 1
    assert intervals[5]["total"] is None
    assert all(v is None for v in intervals[5]["shares"].values())
