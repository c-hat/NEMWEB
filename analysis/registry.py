"""Versioned analysis definitions computed from normalized datasets."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

try:
    from ingest.dataset_contracts import NormalizedDataset, NormalizedDay
except ImportError:  # pragma: no cover - ingest script execution path
    from dataset_contracts import NormalizedDataset, NormalizedDay


REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]
FORECAST_ERROR_RANKING_ID = "demand-forecast-error-ranking"
BAND_BREACH_ID = "band-breach"
REGIONAL_CONTRIBUTION_ID = "regional-contribution"
VERSION = "1.0.0"


@dataclass(frozen=True)
class AnalysisDefinition:
    id: str
    type: str
    label: str
    description: str
    inputs: list[str]
    parameters: dict[str, Any]
    version: str = VERSION

    def descriptor(self, *, updated_at: str | None = None) -> dict:
        out = {
            "id": self.id,
            "type": self.type,
            "label": self.label,
            "description": self.description,
            "inputs": self.inputs,
            "parameters": self.parameters,
            "version": self.version,
        }
        if updated_at is not None:
            out["updatedAt"] = updated_at
        return out


ANALYSIS_DEFINITIONS: dict[str, AnalysisDefinition] = {
    FORECAST_ERROR_RANKING_ID: AnalysisDefinition(
        id=FORECAST_ERROR_RANKING_ID,
        type="forecast-error-ranking",
        label="Largest demand forecast errors",
        description="Top days by mean absolute error between actual demand and day-ahead POE50.",
        inputs=["aemo-nemweb.demand.forecast", "aemo-nemweb.demand.actual"],
        parameters={"metric": "demand", "topN": 15},
    ),
    BAND_BREACH_ID: AnalysisDefinition(
        id=BAND_BREACH_ID,
        type="band-breach",
        label="Forecast band breaches",
        description="Intervals where actual values fall outside the POE10-POE90 forecast band.",
        inputs=["aemo-nemweb.<metric>.forecast", "aemo-nemweb.<metric>.actual"],
        parameters={"metric": "demand"},
    ),
    REGIONAL_CONTRIBUTION_ID: AnalysisDefinition(
        id=REGIONAL_CONTRIBUTION_ID,
        type="regional-contribution",
        label="Regional contribution",
        description="Each region's interval contribution to the NEM total.",
        inputs=["aemo-nemweb.<metric>.actual"],
        parameters={"metric": "demand", "series": "actual"},
    ),
}


def normalized_day_from_compat(day: dict) -> NormalizedDay:
    """Convert current per-day compatibility JSON to normalized analysis inputs."""
    trading_date = day["tradingDate"]
    regions = day["regions"]
    intervals = regions["NSW1"]["demand"]["intervals"]

    def dataset(metric: str, kind: str, keys: list[str]) -> NormalizedDataset:
        values = {
            region: {key: regions[region][metric][key] for key in keys}
            for region in REGIONS
        }
        return NormalizedDataset(
            id=f"compat.{metric}.{kind}.{trading_date}",
            source="compat",
            metric=metric,
            kind=kind,
            cadence="30m",
            units="MW",
            interval_timezone="AEST+10:00",
            intervals=intervals,
            regions=REGIONS.copy(),
            values=values,
        )

    return NormalizedDay(
        trading_date=trading_date,
        forecast_issued_at=day["forecastIssuedAt"],
        datasets={
            "demandForecast": dataset("demand", "forecast", ["poe10", "poe50", "poe90"]),
            "demandActual": dataset("demand", "actual", ["actual"]),
            "rooftopPvForecast": dataset("rooftopPv", "forecast", ["poe10", "poe50", "poe90"]),
            "rooftopPvActual": dataset("rooftopPv", "actual", ["actual"]),
        },
    )


def _generated_at(generated_at: str | None = None) -> str:
    return generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _payload(definition: AnalysisDefinition, data: dict, generated_at: str | None = None) -> dict:
    return {
        "id": definition.id,
        "type": definition.type,
        "version": definition.version,
        "inputs": definition.inputs,
        "parameters": definition.parameters,
        "generatedAt": _generated_at(generated_at),
        "data": data,
    }


def _mae(poe50: list[float | None], actual: list[float | None]) -> tuple[float, float, int] | None:
    abs_sum = 0.0
    signed_sum = 0.0
    n = 0
    for f, a in zip(poe50, actual):
        if f is None or a is None:
            continue
        diff = a - f
        abs_sum += abs(diff)
        signed_sum += diff
        n += 1
    if n == 0:
        return None
    return abs_sum / n, signed_sum / n, n


def _entry(date: str, mae: tuple[float, float, int]) -> dict:
    avg_abs, avg_signed, n = mae
    return {
        "date": date,
        "maeMw": round(avg_abs, 1),
        "meanSignedErrorMw": round(avg_signed, 1),
        "intervals": n,
    }


def _sum_regions(values: dict[str, list[float | None]]) -> list[float | None]:
    first = next(iter(values.values()), [])
    out: list[float | None] = []
    for i in range(len(first)):
        total = 0.0
        missing = False
        for region in REGIONS:
            v = values[region][i]
            if v is None:
                missing = True
                break
            total += v
        out.append(None if missing else total)
    return out


def forecast_error_ranking_payload(
    days: list[NormalizedDay],
    *,
    top_n: int = 15,
    generated_at: str | None = None,
) -> dict:
    definition = ANALYSIS_DEFINITIONS[FORECAST_ERROR_RANKING_ID]
    per_region: dict[str, list[dict]] = {r: [] for r in REGIONS}
    per_region["NEM"] = []

    for day in sorted(days, key=lambda d: d.trading_date):
        forecast = day.datasets["demandForecast"]
        actual = day.datasets["demandActual"]
        nem_forecast: dict[str, list[float | None]] = {}
        nem_actual: dict[str, list[float | None]] = {}
        for region in REGIONS:
            poe50 = forecast.values[region]["poe50"]
            actuals = actual.values[region]["actual"]
            nem_forecast[region] = poe50
            nem_actual[region] = actuals
            mae = _mae(poe50, actuals)
            if mae is not None:
                per_region[region].append(_entry(day.trading_date, mae))
        nem = _mae(_sum_regions(nem_forecast), _sum_regions(nem_actual))
        if nem is not None:
            per_region["NEM"].append(_entry(day.trading_date, nem))

    ranked = {
        region: sorted(rows, key=lambda e: e["maeMw"], reverse=True)[:top_n]
        for region, rows in per_region.items()
    }
    data = {
        "metric": "daily_mean_abs_demand_error_mw",
        "description": definition.description,
        "topN": top_n,
        "regions": ranked,
    }
    payload = _payload(definition, data, generated_at)
    payload["parameters"] = {**payload["parameters"], "topN": top_n}
    return payload


def compatibility_rankings(payload: dict) -> dict:
    return payload["data"]


def band_breach_payload(
    day: NormalizedDay,
    *,
    metric: str = "demand",
    generated_at: str | None = None,
) -> dict:
    definition = ANALYSIS_DEFINITIONS[BAND_BREACH_ID]
    forecast = day.datasets[f"{metric}Forecast"]
    actual = day.datasets[f"{metric}Actual"]
    regions: dict[str, list[dict]] = {}

    for region in REGIONS:
        breaches: list[dict] = []
        for i, interval in enumerate(forecast.intervals):
            value = actual.values[region]["actual"][i]
            high = forecast.values[region]["poe10"][i]
            low = forecast.values[region]["poe90"][i]
            if value is None or high is None or low is None:
                continue
            if value > high or value < low:
                breaches.append(
                    {
                        "interval": interval,
                        "actual": value,
                        "poe10": high,
                        "poe90": low,
                        "direction": "above" if value > high else "below",
                    }
                )
        regions[region] = breaches

    data = {"tradingDate": day.trading_date, "metric": metric, "regions": regions}
    payload = _payload(definition, data, generated_at)
    payload["parameters"] = {**payload["parameters"], "metric": metric}
    return payload


def regional_contribution_payload(
    day: NormalizedDay,
    *,
    metric: str = "demand",
    series: str = "actual",
    generated_at: str | None = None,
) -> dict:
    definition = ANALYSIS_DEFINITIONS[REGIONAL_CONTRIBUTION_ID]
    dataset = day.datasets[f"{metric}{'Actual' if series == 'actual' else 'Forecast'}"]
    region_values = {region: dataset.values[region][series] for region in REGIONS}
    totals = _sum_regions(region_values)
    intervals: list[dict] = []

    for i, interval in enumerate(dataset.intervals):
        total = totals[i]
        shares = {
            region: None
            if total is None or total == 0 or region_values[region][i] is None
            else round(region_values[region][i] / total, 6)
            for region in REGIONS
        }
        intervals.append({"interval": interval, "total": total, "shares": shares})

    data = {
        "tradingDate": day.trading_date,
        "metric": metric,
        "series": series,
        "intervals": intervals,
    }
    payload = _payload(definition, data, generated_at)
    payload["parameters"] = {**payload["parameters"], "metric": metric, "series": series}
    return payload
