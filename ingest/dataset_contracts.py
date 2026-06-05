"""Normalized dataset contracts used by source adapters.

These Python shapes are intentionally independent of the frontend compatibility
JSON. The current ingest still projects them back to ``public/data/*.json``,
but future storage/API work can persist these datasets directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date as date_cls
from typing import Protocol


Series = list[float | None]


@dataclass(frozen=True)
class NormalizedDataset:
    """One normalized regional time-series dataset."""

    id: str
    source: str
    metric: str
    kind: str
    cadence: str
    units: str
    interval_timezone: str
    intervals: list[str]
    regions: list[str]
    values: dict[str, dict[str, Series]]


@dataclass(frozen=True)
class NormalizedDay:
    """Datasets and metadata needed to project one trading day."""

    trading_date: str
    forecast_issued_at: str
    datasets: dict[str, NormalizedDataset]


class SourceAdapter(Protocol):
    """Adapter that emits normalized datasets for a trading day."""

    id: str

    def build_day(self, trading_day: date_cls, include_actuals: bool = True) -> NormalizedDay:
        ...
