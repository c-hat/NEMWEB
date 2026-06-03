"""Demand forecast-error rankings.

For every ingested trading day, computes the daily **mean absolute error**
between actual operational demand and the day-ahead POE50 forecast, per region
(plus a NEM-wide aggregate), and keeps the top-N worst days per region.

Recomputed from all day files after each ingest, so it stays correct as new
days are added (a day enters the list iff its MAE beats the current Nth). The
result is written to ``demand-error-rankings.json`` in the output directory,
which the static frontend reads to populate the "Largest demand errors" menu.
"""
from __future__ import annotations

import json
from pathlib import Path

REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]
TOP_N = 15


def _mae(poe50: list, actual: list) -> tuple[float, float, int] | None:
    """Mean absolute error over intervals where both values are present.

    Returns (mae, mean_signed_error, n) or None if no overlapping intervals.
    """
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


def _nem_series(regions: dict, key: str) -> list:
    """Sum a demand series across all five regions per interval (None if any missing)."""
    cols = [regions[r]["demand"][key] for r in REGIONS]
    out = []
    for i in range(len(cols[0])):
        vals = [c[i] for c in cols]
        out.append(None if any(v is None for v in vals) else sum(vals))
    return out


def _entry(date: str, mae: tuple[float, float, int]) -> dict:
    avg_abs, avg_signed, n = mae
    return {
        "date": date,
        "maeMw": round(avg_abs, 1),
        "meanSignedErrorMw": round(avg_signed, 1),
        "intervals": n,
    }


def compute_rankings(out_dir: Path, top_n: int = TOP_N) -> dict:
    per_region: dict[str, list[dict]] = {r: [] for r in REGIONS}
    per_region["NEM"] = []

    for p in sorted(out_dir.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json")):
        day = json.loads(p.read_text())
        date = day["tradingDate"]
        regions = day["regions"]
        for r in REGIONS:
            d = regions[r]["demand"]
            mae = _mae(d["poe50"], d["actual"])
            if mae is not None:
                per_region[r].append(_entry(date, mae))
        nem = _mae(_nem_series(regions, "poe50"), _nem_series(regions, "actual"))
        if nem is not None:
            per_region["NEM"].append(_entry(date, nem))

    ranked = {
        region: sorted(rows, key=lambda e: e["maeMw"], reverse=True)[:top_n]
        for region, rows in per_region.items()
    }
    return {
        "metric": "daily_mean_abs_demand_error_mw",
        "description": "Top days by mean absolute error between actual demand and day-ahead POE50.",
        "topN": top_n,
        "regions": ranked,
    }


def write_rankings(out_dir: Path, top_n: int = TOP_N) -> Path:
    out_dir = Path(out_dir)
    rankings = compute_rankings(out_dir, top_n)
    path = out_dir / "demand-error-rankings.json"
    path.write_text(json.dumps(rankings, separators=(",", ":")))
    return path
