"""Pure transformations for the live forecaster system-context products.

The NEMWEB fetcher owns source-specific HTTP and ZIP handling.  This module
turns parsed source tables and the existing live series into stable, additive
browser contracts.  Keeping these transformations pure makes the event and
briefing logic fixture-testable without network access.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


AEST = timezone(timedelta(hours=10))
REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]
AREA_REGIONS = {
    "NSW1": "NSW1",
    "VIC1": "VIC1",
    "SA1": "SA1",
    "QLDNORTH": "QLD1",
    "QLDCENTRAL": "QLD1",
    "QLDSOUTH": "QLD1",
    "TASNORTH": "TAS1",
    "TASSOUTH": "TAS1",
}
AREA_LABELS = {
    "NSW1": "New South Wales",
    "VIC1": "Victoria",
    "SA1": "South Australia",
    "QLDNORTH": "Queensland North",
    "QLDCENTRAL": "Queensland Central",
    "QLDSOUTH": "Queensland South",
    "TASNORTH": "Tasmania North",
    "TASSOUTH": "Tasmania South",
}


def parse_aest_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    for fmt in (
        "%Y/%m/%d %H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y/%m/%d %H:%M",
        "%Y-%m-%d %H:%M",
    ):
        try:
            return datetime.strptime(value.strip(), fmt).replace(tzinfo=AEST)
        except ValueError:
            continue
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=AEST) if parsed.tzinfo is None else parsed.astimezone(AEST)
    except ValueError:
        return None


def aest_iso(value: str | None) -> str | None:
    parsed = parse_aest_timestamp(value)
    return parsed.strftime("%Y-%m-%dT%H:%M:%S+10:00") if parsed else None


def number(row: dict[str, str], key: str) -> float | None:
    try:
        value = float(row.get(key, ""))
    except (TypeError, ValueError):
        return None
    return round(value, 2)


def integer(row: dict[str, str], key: str) -> int:
    value = number(row, key)
    return int(value) if value is not None else 0


def table_rows(tables: dict[str, list[dict[str, str]]], suffix: str) -> list[dict[str, str]]:
    for name, rows in tables.items():
        if name.endswith(suffix):
            return rows
    return []


def parse_rooftop_area_actual(
    tables: dict[str, list[dict[str, str]]], trading_date: str
) -> dict[str, list[dict[str, Any]]]:
    points: dict[str, list[dict[str, Any]]] = {}
    for row in table_rows(tables, "ROOFTOP_ACTUAL"):
        area = row.get("AREAID", "")
        observed_at = aest_iso(row.get("INTERVAL_DATETIME"))
        if area not in AREA_REGIONS or not observed_at or observed_at[:10] != trading_date:
            continue
        points.setdefault(area, []).append(
            {
                "ts": observed_at,
                "value": number(row, "POWER"),
                "quality": number(row, "QI"),
                "estimateType": row.get("TYPE") or None,
            }
        )
    for area in points:
        points[area].sort(key=lambda point: point["ts"])
    return points


def parse_rooftop_area_forecast(
    tables: dict[str, list[dict[str, str]]], trading_date: str
) -> dict[str, dict[str, Any]]:
    by_area: dict[str, list[dict[str, Any]]] = {}
    for row in table_rows(tables, "ROOFTOP_FORECAST"):
        area = row.get("AREAID", "")
        interval = aest_iso(row.get("INTERVAL_DATETIME"))
        if area not in AREA_REGIONS or not interval or interval[:10] != trading_date:
            continue
        by_area.setdefault(area, []).append(
            {
                "ts": interval,
                "mean": number(row, "POWERMEAN"),
                "poe50": number(row, "POWERPOE50"),
                "poe90": number(row, "POWERPOELOW"),
                "poe10": number(row, "POWERPOEHIGH"),
            }
        )

    result: dict[str, dict[str, Any]] = {}
    for area, points in by_area.items():
        points.sort(key=lambda point: point["ts"])
        result[area] = {
            "areaId": area,
            "label": AREA_LABELS[area],
            "region": AREA_REGIONS[area],
            "intervals": [point["ts"] for point in points],
            "mean": [point["mean"] for point in points],
            "poe50": [point["poe50"] for point in points],
            "poe90": [point["poe90"] for point in points],
            "poe10": [point["poe10"] for point in points],
        }
    return result


def merge_area_actuals(
    previous_context: dict[str, Any] | None,
    fresh: dict[str, list[dict[str, Any]]],
    trading_date: str,
) -> dict[str, dict[str, Any]]:
    previous_areas = (
        ((previous_context or {}).get("rooftopPvAreas") or {}).get("areas") or {}
    )
    result: dict[str, dict[str, Any]] = {}
    for area in AREA_REGIONS:
        previous_points = (previous_areas.get(area) or {}).get("actual") or []
        by_ts = {
            point.get("ts"): point
            for point in previous_points
            if isinstance(point, dict) and str(point.get("ts", ""))[:10] == trading_date
        }
        for point in fresh.get(area, []):
            by_ts[point["ts"]] = point
        result[area] = {
            "areaId": area,
            "label": AREA_LABELS[area],
            "region": AREA_REGIONS[area],
            "actual": [by_ts[key] for key in sorted(by_ts) if key],
        }
    return result


def parse_facility_metadata(body: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    metadata: dict[str, dict[str, Any]] = {}
    for facility in (body or {}).get("data") or []:
        if not isinstance(facility, dict):
            continue
        for unit in facility.get("units") or []:
            if not isinstance(unit, dict) or not unit.get("code"):
                continue
            capacity = unit.get("capacity_registered")
            if capacity is None:
                capacity = unit.get("capacity_mw")
            metadata[str(unit["code"])] = {
                "facilityCode": facility.get("code"),
                "facilityName": facility.get("name"),
                "region": facility.get("network_region"),
                "fueltech": unit.get("fueltech_id"),
                "status": unit.get("status_id"),
                "capacityMw": capacity,
            }
    return metadata


def parse_duid_scada(
    tables: dict[str, list[dict[str, str]]],
    metadata: dict[str, dict[str, Any]],
    previous_context: dict[str, Any] | None,
) -> dict[str, Any]:
    rows = table_rows(tables, "DISPATCH_UNIT_SCADA")
    previous_assets = {
        asset.get("duid"): asset
        for asset in ((previous_context or {}).get("duidScada") or {}).get("assets") or []
        if isinstance(asset, dict) and asset.get("duid")
    }
    assets: list[dict[str, Any]] = []
    observed_at: str | None = None
    for row in rows:
        duid = row.get("DUID")
        current = number(row, "SCADAVALUE")
        row_observed_at = aest_iso(row.get("SETTLEMENTDATE"))
        if not duid or current is None or not row_observed_at:
            continue
        observed_at = max(observed_at or row_observed_at, row_observed_at)
        prior = previous_assets.get(duid) or {}
        previous_mw = prior.get("currentMw")
        delta = round(current - previous_mw, 2) if isinstance(previous_mw, (int, float)) else None
        assets.append(
            {
                "duid": duid,
                **(metadata.get(duid) or {}),
                "observedAt": row_observed_at,
                "currentMw": current,
                "previousMw": previous_mw,
                "deltaMw": delta,
            }
        )
    assets.sort(key=lambda asset: asset["duid"])
    return {"observedAt": observed_at, "assets": assets}


def parse_dispatch_context(tables: dict[str, list[dict[str, str]]]) -> dict[str, Any]:
    region_rows = [row for row in table_rows(tables, "DISPATCH_REGIONSUM") if row.get("INTERVENTION") == "0"]
    price_rows = [row for row in table_rows(tables, "DISPATCH_PRICE") if row.get("INTERVENTION") == "0"]
    prices = {row.get("REGIONID"): number(row, "RRP") for row in price_rows if row.get("REGIONID")}
    regions: dict[str, Any] = {}
    observed_at: str | None = None
    for row in region_rows:
        region = row.get("REGIONID", "")
        if region not in REGIONS:
            continue
        row_observed_at = aest_iso(row.get("SETTLEMENTDATE"))
        observed_at = max(observed_at or row_observed_at or "", row_observed_at or "") or observed_at
        regions[region] = {
            "rrp": prices.get(region),
            "totalDemandMw": number(row, "TOTALDEMAND"),
            "availableGenerationMw": number(row, "AVAILABLEGENERATION"),
            "netInterchangeMw": number(row, "NETINTERCHANGE"),
            "uigfMw": number(row, "UIGF"),
            "windUigfMw": number(row, "SS_WIND_UIGF"),
            "solarUigfMw": number(row, "SS_SOLAR_UIGF"),
            "windClearedMw": number(row, "SS_WIND_CLEAREDMW"),
            "solarClearedMw": number(row, "SS_SOLAR_CLEAREDMW"),
        }

    constraints: list[dict[str, Any]] = []
    for row in table_rows(tables, "DISPATCH_CONSTRAINT"):
        if row.get("INTERVENTION") != "0":
            continue
        marginal = number(row, "MARGINALVALUE") or 0
        violation = number(row, "VIOLATIONDEGREE") or 0
        if marginal <= 0 and violation <= 0:
            continue
        constraints.append(
            {
                "constraintId": row.get("CONSTRAINTID"),
                "rhs": number(row, "RHS"),
                "lhs": number(row, "LHS"),
                "marginalValue": marginal,
                "violationDegree": violation,
            }
        )
    constraints.sort(key=lambda item: (item["violationDegree"], item["marginalValue"]), reverse=True)

    interconnectors: list[dict[str, Any]] = []
    for row in table_rows(tables, "DISPATCH_INTERCONNECTORRES"):
        if row.get("INTERVENTION") != "0":
            continue
        interconnectors.append(
            {
                "interconnectorId": row.get("INTERCONNECTORID"),
                "meteredMw": number(row, "METEREDMWFLOW"),
                "targetMw": number(row, "MWFLOW"),
                "exportLimitMw": number(row, "EXPORTLIMIT"),
                "importLimitMw": number(row, "IMPORTLIMIT"),
                "marginalValue": number(row, "MARGINALVALUE"),
                "violationDegree": number(row, "VIOLATIONDEGREE"),
                "exportConstraintId": row.get("EXPORTGENCONID") or None,
                "importConstraintId": row.get("IMPORTGENCONID") or None,
            }
        )
    return {
        "observedAt": observed_at,
        "regions": regions,
        "bindingConstraints": constraints[:20],
        "interconnectors": interconnectors,
    }


def parse_reserve_context(
    tables: dict[str, list[dict[str, str]]], now: datetime
) -> dict[str, Any]:
    rows = table_rows(tables, "PDPASA_REGIONSOLUTION")
    run_at: str | None = None
    horizon_end = now.astimezone(AEST) + timedelta(hours=24)
    regions: dict[str, list[dict[str, Any]]] = {region: [] for region in REGIONS}
    for row in rows:
        if row.get("RUNTYPE") != "LOR":
            continue
        region = row.get("REGIONID", "")
        interval_dt = parse_aest_timestamp(row.get("INTERVAL_DATETIME"))
        if region not in regions or interval_dt is None or interval_dt < now.astimezone(AEST) or interval_dt > horizon_end:
            continue
        run_at = max(run_at or aest_iso(row.get("RUN_DATETIME")) or "", aest_iso(row.get("RUN_DATETIME")) or "") or run_at
        regions[region].append(
            {
                "ts": interval_dt.strftime("%Y-%m-%dT%H:%M:%S+10:00"),
                "surplusReserveMw": number(row, "SURPLUSRESERVE"),
                "maxSpareCapacityMw": number(row, "MAXSPARECAPACITY"),
                "lorCondition": integer(row, "LORCONDITION"),
                "demandPoe50Mw": number(row, "DEMAND50"),
                "windUigfMw": number(row, "SS_WIND_UIGF"),
                "solarUigfMw": number(row, "SS_SOLAR_UIGF"),
            }
        )

    summaries: dict[str, Any] = {}
    for region, intervals in regions.items():
        intervals.sort(key=lambda item: item["ts"])
        reserve_points = [item for item in intervals if item["surplusReserveMw"] is not None]
        minimum = min(reserve_points, key=lambda item: item["surplusReserveMw"]) if reserve_points else None
        summaries[region] = {
            "minimumSurplusReserveMw": minimum["surplusReserveMw"] if minimum else None,
            "minimumAt": minimum["ts"] if minimum else None,
            "worstLorCondition": max((item["lorCondition"] for item in intervals), default=0),
            "intervals": intervals,
        }
    return {"runAt": run_at, "horizonHours": 24, "regions": summaries}


def latest_value(points: list[dict[str, Any]]) -> tuple[str | None, float | None]:
    for point in reversed(points):
        value = point.get("value")
        if isinstance(value, (int, float)):
            return point.get("ts"), float(value)
    return None, None


def value_at_or_before(points: list[dict[str, Any]], target_ms: float) -> float | None:
    chosen: float | None = None
    for point in points:
        try:
            point_ms = datetime.fromisoformat(str(point.get("ts"))).timestamp() * 1000
        except ValueError:
            continue
        if point_ms > target_ms:
            break
        value = point.get("value")
        if isinstance(value, (int, float)):
            chosen = float(value)
    return chosen


def ramp(points: list[dict[str, Any]], minutes: int) -> float | None:
    ts, current = latest_value(points)
    if ts is None or current is None:
        return None
    current_ms = datetime.fromisoformat(ts).timestamp() * 1000
    previous = value_at_or_before(points, current_ms - minutes * 60_000)
    return round(current - previous, 1) if previous is not None else None


def build_region_metrics(
    demand: dict[str, list[dict[str, Any]]], rooftop: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    regions: dict[str, Any] = {}
    for region in [*REGIONS, "NEM"]:
        demand_points = demand.get(region, [])
        rooftop_points = rooftop.get(region, [])
        demand_at, demand_mw = latest_value(demand_points)
        rooftop_at, rooftop_mw = latest_value(rooftop_points)
        underlying_mw: float | None = None
        if rooftop_at and rooftop_mw is not None:
            demand_same_time = value_at_or_before(
                demand_points, datetime.fromisoformat(rooftop_at).timestamp() * 1000
            )
            if demand_same_time is not None:
                underlying_mw = round(demand_same_time + rooftop_mw, 1)
        regions[region] = {
            "operationalDemand": {
                "observedAt": demand_at,
                "currentMw": round(demand_mw, 1) if demand_mw is not None else None,
                "rampsMw": {"5m": ramp(demand_points, 5), "30m": ramp(demand_points, 30), "60m": ramp(demand_points, 60)},
            },
            "underlyingDemand": {
                "observedAt": rooftop_at,
                "currentMw": underlying_mw,
                "definition": "operational demand plus estimated rooftop PV",
            },
        }
    return regions


def _forecast_revision_events(context: dict[str, Any], previous: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not previous:
        return []
    events: list[dict[str, Any]] = []
    current_forecast = context.get("currentForecast") or {}
    previous_forecast = previous.get("currentForecast") or {}
    for metric in ("demand", "rooftopPv"):
        current_regions = (current_forecast.get(metric) or {}).get("regions") or {}
        previous_regions = (previous_forecast.get(metric) or {}).get("regions") or {}
        for region in REGIONS:
            current_series = current_regions.get(region) or {}
            previous_series = previous_regions.get(region) or {}
            prior = dict(zip(previous_series.get("intervals") or [], previous_series.get("poe50") or []))
            deltas = []
            for ts, value in zip(current_series.get("intervals") or [], current_series.get("poe50") or []):
                old = prior.get(ts)
                if isinstance(value, (int, float)) and isinstance(old, (int, float)):
                    deltas.append((ts, round(value - old, 1)))
            if not deltas:
                continue
            peak_ts, peak_delta = max(deltas, key=lambda item: abs(item[1]))
            threshold = 200 if metric == "demand" else 100
            if abs(peak_delta) < threshold:
                continue
            label = "demand" if metric == "demand" else "rooftop PV"
            direction = "higher" if peak_delta > 0 else "lower"
            events.append(
                {
                    "id": f"forecast-revision:{metric}:{region}:{peak_ts}",
                    "type": "forecast-revision",
                    "status": "active",
                    "severity": "watch",
                    "scope": {"kind": "region", "id": region},
                    "observedAt": context.get("updatedAt"),
                    "headline": f"{region} {label} forecast revised {direction} by {abs(peak_delta):,.0f} MW",
                    "detail": f"Largest common-interval POE50 change is at {peak_ts[11:16]} AEST.",
                    "metrics": {"metric": metric, "deltaMw": peak_delta, "interval": peak_ts},
                    "evidence": [metric + "-current-forecast"],
                    "confidence": "high",
                }
            )
    return events


def build_briefing(context: dict[str, Any], previous: dict[str, Any] | None) -> dict[str, Any]:
    events = _forecast_revision_events(context, previous)
    updated_at = context.get("updatedAt")

    for region, metrics in (context.get("regions") or {}).items():
        ramp_30 = ((metrics.get("operationalDemand") or {}).get("rampsMw") or {}).get("30m")
        threshold = 800 if region == "NEM" else 300
        if isinstance(ramp_30, (int, float)) and abs(ramp_30) >= threshold:
            direction = "up" if ramp_30 > 0 else "down"
            events.append(
                {
                    "id": f"demand-ramp:{region}:{updated_at}",
                    "type": "demand-ramp",
                    "status": "active",
                    "severity": "watch",
                    "scope": {"kind": "region", "id": region},
                    "observedAt": updated_at,
                    "headline": f"{region} operational demand ramped {direction} {abs(ramp_30):,.0f} MW in 30 minutes",
                    "detail": "Operational demand is the grid-supplied demand already net of rooftop PV.",
                    "metrics": {"rampMw": ramp_30, "windowMinutes": 30},
                    "evidence": ["live-operational-demand"],
                    "confidence": "high",
                }
            )

    reserve_regions = ((context.get("reserve") or {}).get("regions") or {})
    for region, reserve in reserve_regions.items():
        lor = reserve.get("worstLorCondition") or 0
        if lor:
            events.append(
                {
                    "id": f"reserve-risk:{region}:{updated_at}",
                    "type": "reserve-risk",
                    "status": "active",
                    "severity": "critical" if lor >= 2 else "warning",
                    "scope": {"kind": "region", "id": region},
                    "observedAt": updated_at,
                    "headline": f"{region} has forecast LOR{lor} in the next 24 hours",
                    "detail": f"Minimum forecast surplus reserve is {reserve.get('minimumSurplusReserveMw') or 0:,.0f} MW.",
                    "metrics": {"lorCondition": lor, "minimumSurplusReserveMw": reserve.get("minimumSurplusReserveMw"), "minimumAt": reserve.get("minimumAt")},
                    "evidence": ["aemo-pdpasa"],
                    "confidence": "high",
                }
            )

    for constraint in ((context.get("dispatch") or {}).get("bindingConstraints") or [])[:5]:
        events.append(
            {
                "id": f"binding-constraint:{constraint.get('constraintId')}:{updated_at}",
                "type": "binding-constraint",
                "status": "active",
                "severity": "warning" if (constraint.get("violationDegree") or 0) > 0 else "info",
                "scope": {"kind": "constraint", "id": constraint.get("constraintId")},
                "observedAt": updated_at,
                "headline": f"Constraint {constraint.get('constraintId')} is binding",
                "detail": f"Marginal value {constraint.get('marginalValue') or 0:,.2f}; violation {constraint.get('violationDegree') or 0:,.2f}.",
                "metrics": constraint,
                "evidence": ["aemo-dispatchis"],
                "confidence": "high",
            }
        )

    vre_movers = [
        asset
        for asset in ((context.get("duidScada") or {}).get("assets") or [])
        if asset.get("fueltech") in ("wind", "solar_utility") and isinstance(asset.get("deltaMw"), (int, float))
    ]
    vre_movers.sort(key=lambda asset: abs(asset["deltaMw"]), reverse=True)
    for asset in [asset for asset in vre_movers if abs(asset["deltaMw"]) >= 40][:3]:
        direction = "increased" if asset["deltaMw"] > 0 else "decreased"
        events.append(
            {
                "id": f"duid-movement:{asset['duid']}:{updated_at}",
                "type": "duid-movement",
                "status": "active",
                "severity": "info",
                "scope": {"kind": "duid", "id": asset["duid"], "region": asset.get("region")},
                "observedAt": asset.get("observedAt"),
                "headline": f"{asset['duid']} output {direction} {abs(asset['deltaMw']):,.0f} MW",
                "detail": "SCADA movement since the previous live-data run; cause is not inferred.",
                "metrics": {"deltaMw": asset["deltaMw"], "currentMw": asset["currentMw"], "fueltech": asset.get("fueltech")},
                "evidence": ["aemo-dispatch-unit-scada"],
                "confidence": "high",
            }
        )

    severity_order = {"critical": 0, "warning": 1, "watch": 2, "info": 3}
    events.sort(key=lambda event: severity_order.get(event["severity"], 9))
    changes = [
        {
            "eventId": event["id"],
            "severity": event["severity"],
            "headline": event["headline"],
            "detail": event["detail"],
        }
        for event in events[:8]
    ]
    summary = (
        f"{len(events)} active system item{'s' if len(events) != 1 else ''}; {len(changes)} shown in this briefing."
        if events
        else "No material changes crossed the first-release thresholds since the previous live-data run."
    )
    return {
        "schemaVersion": "1.0.0",
        "generatedAt": updated_at,
        "comparedWith": (previous or {}).get("updatedAt"),
        "summary": summary,
        "changes": changes,
        "events": events,
    }

