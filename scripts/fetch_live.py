#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.32"]
# ///
"""Fetch today's live NEM demand and rooftop PV actuals, plus the current
POE50 forecasts for the rest of the day.

Data sources:
  - Demand actuals:    OpenElectricity API (5-min cadence, OE_API_KEY required)
  - Rooftop actuals:  NEMWEB ROOFTOP_PV/ACTUAL/ (30-min cadence, unauthenticated)
  - Demand forecast:  NEMWEB Operational_Demand/FORECAST_HH/ (30-min cadence)
  - Rooftop forecast: NEMWEB ROOFTOP_PV/FORECAST/ (30-min cadence)

Writes a single JSON file (default ``today-live.json``) that the frontend reads
over ``raw.githubusercontent.com`` from the force-pushed ``live-data`` branch.

Output shape::

    {
      "updatedAt": "2026-06-03T04:10:07Z",
      "regions": {
        "NSW1": { "demand": [{"ts": "...", "value": 7123.4}, ...],
                  "rooftopPv": [{"ts": "...", "value": 812.0}, ...] },
        ... VIC1, QLD1, SA1, TAS1 ...,
        "NEM":  { "demand": [...], "rooftopPv": [...] }
      },
      "currentForecast": {
        "demand": {
          "issuedAt": "2026-06-03T13:00:00+10:00",
          "regions": {
            "NSW1": { "intervals": [...], "poe50": [...] }, ...
          }
        },
        "rooftopPv": { "issuedAt": "...", "regions": { ... } }
      }
    }

Rate-limit budget (OE free tier = 500 requests/day):
  - Demand: ONE multi-region request per run (all five regions in one call).
  - Rooftop actuals + forecasts: fetched from NEMWEB on every run. NEMWEB is
    unauthenticated, and fetching every 10 min avoids waiting until the next
    half-hour gate when a rooftop actual ZIP is published a few minutes late.
  - Budget: exactly 1 OE request per run. The run aborts if this is exceeded.

Usage::

    OE_API_KEY=... uv run scripts/fetch_live.py --out today-live.json \
        --prev prev-live.json [--force-rooftop] [-v]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import os
import re
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:
    from forecaster_context import (
        build_briefing,
        build_region_metrics,
        merge_area_actuals,
        parse_dispatch_context,
        parse_duid_scada,
        parse_facility_metadata,
        parse_reserve_context,
        parse_rooftop_area_actual,
        parse_rooftop_area_forecast,
    )
except ModuleNotFoundError:  # importlib-based tests load the script outside scripts/
    from scripts.forecaster_context import (
        build_briefing,
        build_region_metrics,
        merge_area_actuals,
        parse_dispatch_context,
        parse_duid_scada,
        parse_facility_metadata,
        parse_reserve_context,
        parse_rooftop_area_actual,
        parse_rooftop_area_forecast,
    )


log = logging.getLogger("fetch_live")

# OE publishes NEM data in network time, which is AEST (UTC+10, no DST).
AEST = timezone(timedelta(hours=10))

OE_BASE = "https://api.openelectricity.org.au"
# 5-minute operational demand (DISPATCHREGIONSUM.TOTALDEMAND), all regions.
DEMAND_PATH = "/v4/market/network/NEM"

NEMWEB_BASE = "https://nemweb.com.au"
ROOFTOP_ACTUAL_PATH = "Reports/CURRENT/ROOFTOP_PV/ACTUAL/"
DEMAND_FORECAST_PATH = "Reports/CURRENT/Operational_Demand/FORECAST_HH/"
ROOFTOP_FORECAST_PATH = "Reports/CURRENT/ROOFTOP_PV/FORECAST/"
ROOFTOP_ACTUAL_AREA_PATH = "Reports/CURRENT/ROOFTOP_PV/ACTUAL_AREA/"
ROOFTOP_FORECAST_AREA_PATH = "Reports/CURRENT/ROOFTOP_PV/FORECAST_AREA/"
DISPATCH_SCADA_PATH = "Reports/CURRENT/Dispatch_SCADA/"
DISPATCHIS_PATH = "Reports/CURRENT/DispatchIS_Reports/"
PDPASA_PATH = "Reports/CURRENT/PDPASA/"

REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]

USER_AGENT = "nemweb-live-fetch/0.1 (+https://github.com/c-hat/nemweb)"

# Interpolate within a native rooftop interval, not across long flat runs.
INTERP_MAX_GAP_MS = 35 * 60_000

# Apache directory listing href capture.
_HREF_RE = re.compile(r'<a\s+href="([^"?][^"]*)"', re.IGNORECASE)
# NEMWEB filenames embed a 12- or 14-digit timestamp.
_TS_RE = re.compile(r"(\d{12,14})")


# --- HTTP ----------------------------------------------------------------

def _oe_session(api_key: str) -> requests.Session:
    """Authenticated session for the OE API with bounded retries on transient 5xx."""
    s = requests.Session()
    s.headers.update(
        {
            "Authorization": f"Bearer {api_key}",
            "User-Agent": USER_AGENT,
            "Cache-Control": "no-cache",
        }
    )
    retry = Retry(
        total=3,
        backoff_factor=1.0,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def _nemweb_session() -> requests.Session:
    """Unauthenticated session for NEMWEB with bounded retries."""
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    retry = Retry(
        total=3,
        backoff_factor=1.0,
        status_forcelist=[403, 429, 500, 502, 503, 504],
        allowed_methods=frozenset({"GET"}),
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def _oe_get(
    session: requests.Session,
    path: str,
    extra_params: dict[str, str],
    date_start: datetime,
    date_end: datetime,
) -> dict:
    """One multi-region GET against OE. Raises on HTTP error (incl. auth)."""
    params = {
        "interval": "5m",
        "primary_grouping": "network_region",
        "date_start": date_start.strftime("%Y-%m-%dT%H:%M:%S"),
        "date_end": date_end.strftime("%Y-%m-%dT%H:%M:%S"),
        **extra_params,
    }
    resp = session.get(OE_BASE + path, params=params, timeout=60)
    if resp.status_code in (401, 403):
        log.error("OE returned %s — check the OE_API_KEY secret", resp.status_code)
    resp.raise_for_status()
    return resp.json()


# --- NEMWEB directory + ZIP helpers --------------------------------------

def _parse_nemweb_ts(filename: str) -> datetime | None:
    """Extract the embedded YYYYMMDDHHMM[SS] timestamp from a NEMWEB filename."""
    m = _TS_RE.search(filename)
    if not m:
        return None
    s = m.group(1)
    try:
        if len(s) == 14:
            dt = datetime.strptime(s, "%Y%m%d%H%M%S")
        else:
            dt = datetime.strptime(s[:12], "%Y%m%d%H%M")
        return dt.replace(tzinfo=AEST)
    except ValueError:
        return None


def _list_nemweb_dir(session: requests.Session, rel_path: str) -> list[dict]:
    """List a NEMWEB Apache directory; return entries with filename, url, ts."""
    url = f"{NEMWEB_BASE}/{rel_path.strip('/')}/"
    resp = session.get(url, timeout=60)
    resp.raise_for_status()
    entries: list[dict] = []
    seen: set[str] = set()
    for href in _HREF_RE.findall(resp.text):
        if href in seen:
            continue
        seen.add(href)
        if href.endswith("/") or href.startswith("?"):
            continue
        filename = href.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
        if not filename.lower().endswith(".zip"):
            continue
        full_url = href if href.startswith("http") else urljoin(url, href)
        entries.append({"filename": filename, "url": full_url, "ts": _parse_nemweb_ts(filename)})
    return entries


def _parse_mms_csv(text: str) -> dict[str, list[dict]]:
    """Parse an AEMO MMS-format CSV into table_name -> list of row dicts.

    Each table is introduced by an I row (column headers) and followed by D rows
    (data). C rows (comments/footers) are ignored.
    """
    tables: dict[str, list[dict]] = {}
    headers: dict[str, list[str]] = {}
    current: str | None = None
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        marker = row[0]
        if marker == "I" and len(row) >= 5:
            key = f"{row[1].strip()}_{row[2].strip()}"
            current = key
            headers[key] = [c.strip() for c in row[4:]]
            tables.setdefault(key, [])
        elif marker == "D" and current is not None:
            cols = headers[current]
            vals = [v.strip() for v in row[4:]]
            padded = vals + [""] * max(0, len(cols) - len(vals))
            tables[current].append(dict(zip(cols, padded[: len(cols)])))
    return tables


def _parse_nemweb_zip(zip_bytes: bytes) -> dict[str, list[dict]]:
    """Extract and parse all CSVs from a NEMWEB ZIP (handles one level of nesting)."""
    tables: dict[str, list[dict]] = {}

    def _ingest(data: bytes) -> None:
        text = data.decode("utf-8", errors="replace")
        for k, rows in _parse_mms_csv(text).items():
            tables.setdefault(k, []).extend(rows)

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            name = info.filename.lower()
            if name.endswith(".csv"):
                _ingest(zf.read(info))
            elif name.endswith(".zip"):
                inner = zf.read(info)
                with zipfile.ZipFile(io.BytesIO(inner)) as zf2:
                    for info2 in zf2.infolist():
                        if info2.filename.lower().endswith(".csv"):
                            _ingest(zf2.read(info2))
    return tables


def _fetch_nemweb_zip(session: requests.Session, url: str) -> dict[str, list[dict]]:
    resp = session.get(url, timeout=120)
    resp.raise_for_status()
    return _parse_nemweb_zip(resp.content)


def _fetch_latest_nemweb_tables(
    session: requests.Session, rel_path: str
) -> tuple[str | None, dict[str, list[dict]]]:
    """Fetch the latest timestamped ZIP in a NEMWEB current-report directory."""
    entries = [entry for entry in _list_nemweb_dir(session, rel_path) if entry["ts"] is not None]
    if not entries:
        raise requests.RequestException(f"{rel_path}: no timestamped ZIP entries found")
    latest = max(entries, key=lambda entry: entry["ts"])
    issued_at = latest["ts"].strftime("%Y-%m-%dT%H:%M:%S+10:00")
    log.info("context source %s: %s", rel_path, latest["filename"])
    return issued_at, _fetch_nemweb_zip(session, latest["url"])


def _read_optional_json(path: Path | None) -> dict | None:
    if path is None or not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("could not read %s: %s", path, exc)
        return None
    return value if isinstance(value, dict) else None


def _previous_facility_metadata(previous_context: dict | None) -> dict[str, dict]:
    assets = ((previous_context or {}).get("duidScada") or {}).get("assets") or []
    keys = ("facilityCode", "facilityName", "region", "fueltech", "status", "capacityMw")
    return {
        asset["duid"]: {key: asset.get(key) for key in keys}
        for asset in assets
        if isinstance(asset, dict) and asset.get("duid")
    }


def _facility_metadata_is_fresh(previous_context: dict | None, now: datetime) -> bool:
    updated_at = (
        (((previous_context or {}).get("sources") or {}).get("facilityMetadata") or {}).get("updatedAt")
    )
    if not isinstance(updated_at, str):
        return False
    try:
        age = now.astimezone(timezone.utc) - datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return age < timedelta(hours=24)


def _fetch_facilities(session: requests.Session) -> dict:
    response = session.get(
        f"{OE_BASE}/v4/facilities/",
        params=[("network_id", "NEM"), ("status_id", "operating"), ("status_id", "committed")],
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def _parse_aest_ts(s: str) -> datetime | None:
    """Parse an AEMO MMS timestamp (e.g. '2026/05/28 00:30:00') to AEST datetime."""
    if not s:
        return None
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s.strip(), fmt).replace(tzinfo=AEST)
        except ValueError:
            continue
    return None


# --- NEMWEB data fetchers ------------------------------------------------

def fetch_rooftop_actual_nemweb(session: requests.Session, today_str: str) -> dict[str, list[dict]]:
    """Fetch today's rooftop PV actuals (TYPE=MEASUREMENT) from NEMWEB."""
    entries = _list_nemweb_dir(session, ROOFTOP_ACTUAL_PATH)
    ts_entries = [e for e in entries if e["ts"] is not None]
    if not ts_entries:
        log.warning("ROOFTOP_PV/ACTUAL: no timestamped entries found")
        return {}
    latest = max(ts_entries, key=lambda e: e["ts"])
    log.info("rooftop actual: %s (ts=%s)", latest["filename"], latest["ts"])
    tables = _fetch_nemweb_zip(session, latest["url"])

    rows = None
    for k, v in tables.items():
        if v and "POWER" in v[0] and "REGIONID" in v[0] and "INTERVAL_DATETIME" in v[0]:
            rows = v
            break
    if not rows:
        log.warning("ROOFTOP_PV/ACTUAL: no matching table in %s; got: %s", latest["filename"], list(tables))
        return {}

    # Accept both SATELLITE (near-realtime) and MEASUREMENT (finalized) rows.
    # CURRENT/ files typically carry SATELLITE data; MEASUREMENT arrives later.
    seen: dict[tuple, str] = {}  # (region, ts) -> best type so far
    by_key: dict[tuple, dict] = {}
    for row in rows:
        row_type = row.get("TYPE", "")
        if row_type not in ("MEASUREMENT", "SATELLITE"):
            continue
        region = row.get("REGIONID", "")
        if region not in REGIONS:
            continue
        dt = _parse_aest_ts(row.get("INTERVAL_DATETIME", ""))
        if dt is None or dt.strftime("%Y-%m-%d") != today_str:
            continue
        try:
            power = round(float(row["POWER"]), 1)
        except (ValueError, TypeError, KeyError):
            power = None
        ts = dt.strftime("%Y-%m-%dT%H:%M:%S+10:00")
        key = (region, ts)
        prev_type = seen.get(key)
        # MEASUREMENT beats SATELLITE; first row wins within the same type.
        if prev_type is None or (prev_type == "SATELLITE" and row_type == "MEASUREMENT"):
            seen[key] = row_type
            by_key[key] = {"ts": ts, "value": power}

    out: dict[str, list[dict]] = {}
    for (region, _), item in by_key.items():
        out.setdefault(region, []).append(item)

    for r in out:
        out[r].sort(key=lambda p: p["ts"])
    log.info("rooftop actual: %d regions, type breakdown: %s",
             len(out), {t: sum(1 for k, v in seen.items() if v == t) for t in set(seen.values())})
    return out


def _fetch_forecast_nemweb(
    session: requests.Session,
    rel_path: str,
    value_col: str,
    today_str: str,
) -> tuple[str | None, dict[str, dict]]:
    """Generic NEMWEB forecast fetcher. Returns (issuedAt, {region: {intervals, poe50}})."""
    entries = _list_nemweb_dir(session, rel_path)
    ts_entries = [e for e in entries if e["ts"] is not None]
    if not ts_entries:
        log.warning("%s: no timestamped entries found", rel_path)
        return None, {}
    latest = max(ts_entries, key=lambda e: e["ts"])
    issued_at = latest["ts"].strftime("%Y-%m-%dT%H:%M:%S+10:00")
    log.info("%s: %s (issued=%s)", rel_path, latest["filename"], issued_at)

    tables = _fetch_nemweb_zip(session, latest["url"])
    rows = None
    for k, v in tables.items():
        if v and value_col in v[0] and "REGIONID" in v[0]:
            rows = v
            break
    if not rows:
        log.warning("%s: column %s not found; got: %s", rel_path, value_col, list(tables))
        return issued_at, {}

    by_region: dict[str, list[dict]] = {}
    for row in rows:
        region = row.get("REGIONID", "")
        if region not in REGIONS:
            continue
        dt = _parse_aest_ts(row.get("INTERVAL_DATETIME", ""))
        if dt is None or dt.strftime("%Y-%m-%d") != today_str:
            continue
        try:
            val = round(float(row[value_col]), 1)
        except (ValueError, TypeError, KeyError):
            val = None
        ts = dt.strftime("%Y-%m-%dT%H:%M:%S+10:00")
        by_region.setdefault(region, []).append({"ts": ts, "value": val})

    result: dict[str, dict] = {}
    for r, points in by_region.items():
        points.sort(key=lambda p: p["ts"])
        result[r] = {"intervals": [p["ts"] for p in points], "poe50": [p["value"] for p in points]}
    return issued_at, result


def fetch_demand_forecast_nemweb(
    session: requests.Session, today_str: str
) -> tuple[str | None, dict[str, dict]]:
    """Fetch today's demand forecast POE50 from NEMWEB FORECAST_HH/."""
    return _fetch_forecast_nemweb(session, DEMAND_FORECAST_PATH, "OPERATIONAL_DEMAND_POE50", today_str)


def fetch_rooftop_forecast_nemweb(
    session: requests.Session, today_str: str
) -> tuple[str | None, dict[str, dict]]:
    """Fetch today's rooftop PV forecast POE50 from NEMWEB ROOFTOP_PV/FORECAST/."""
    return _fetch_forecast_nemweb(session, ROOFTOP_FORECAST_PATH, "POWERPOE50", today_str)


# --- OE parsing ----------------------------------------------------------

def _results(body: dict) -> list[dict]:
    """The per-group result objects: body.data[0].results, defensively."""
    if not isinstance(body, dict):
        return []
    data = body.get("data") or []
    if not data or not isinstance(data, list):
        return []
    return data[0].get("results") or []


def _region_of(result: dict) -> str | None:
    """Find which NEM region a result belongs to."""
    cols = result.get("columns") or {}
    for candidate in [*cols.values(), result.get("name"), result.get("label")]:
        if candidate is None:
            continue
        s = str(candidate).upper()
        for region in REGIONS:
            if region in s:
                return region
    return None


def _to_aest_iso(ts: str) -> str:
    """Normalise an OE timestamp to AEST ISO with an explicit +10:00 offset."""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ts
    dt = dt.replace(tzinfo=AEST) if dt.tzinfo is None else dt.astimezone(AEST)
    return dt.strftime("%Y-%m-%dT%H:%M:%S+10:00")


def _rows_to_points(rows: list) -> list[dict]:
    """OE data rows ([ts, value], ...) -> [{ts, value}] with full precision."""
    points: list[dict] = []
    for row in rows or []:
        if not row:
            continue
        ts = row[0]
        value = row[1] if len(row) > 1 else None
        points.append({"ts": _to_aest_iso(str(ts)), "value": None if value is None else float(value)})
    return points


def parse_regions(body: dict) -> dict[str, list[dict]]:
    """Map region code -> points from a multi-region OE response."""
    out: dict[str, list[dict]] = {}
    for result in _results(body):
        region = _region_of(result)
        if region is None or region in out:
            continue
        out[region] = _rows_to_points(result.get("data") or [])
    return out


def build_rooftop(body: dict) -> dict[str, list[dict]]:
    """Map OE rooftop energy rows to MW points and smooth held readings.

    Older live tests exercise this pure helper even though rooftop actuals now
    come from NEMWEB. Keeping it here preserves the documented parser behavior
    and makes it available for a future OE live adapter if needed.
    """
    out: dict[str, list[dict]] = {}
    for region, points in parse_regions(body).items():
        converted = [
            {"ts": p["ts"], "value": None if p["value"] is None else p["value"] * 12}
            for p in points
        ]
        out[region] = smooth_held(converted)
    return out


# --- Rooftop smoothing (for carried-forward legacy) ----------------------

def _parse_ms(ts: str) -> int:
    return int(datetime.fromisoformat(ts).timestamp() * 1000)


def smooth_held(points: list[dict]) -> list[dict]:
    """Interpolate held rooftop readings into a smooth line (for OE carry-forward)."""
    anchors: list[tuple[int, float]] = []
    for p in points:
        v = p["value"]
        if v is None:
            continue
        if not anchors or anchors[-1][1] != v:
            anchors.append((_parse_ms(p["ts"]), v))
    if len(anchors) < 2:
        return points

    out: list[dict] = []
    a = 0
    for p in points:
        v = p["value"]
        if v is None:
            out.append(p)
            continue
        ms = _parse_ms(p["ts"])
        while a < len(anchors) - 1 and anchors[a + 1][0] <= ms:
            a += 1
        left = anchors[a]
        right = anchors[a + 1] if a + 1 < len(anchors) else None
        if right is None or ms <= left[0] or right[0] - left[0] > INTERP_MAX_GAP_MS:
            value = left[1]
        else:
            f = (ms - left[0]) / (right[0] - left[0])
            value = left[1] + (right[1] - left[1]) * f
        out.append({"ts": p["ts"], "value": value})
    return out


def sum_nem(series: list[list[dict]]) -> list[dict]:
    """Sum several regions' series by timestamp; a null in any region gives null."""
    sums: dict[str, float | None] = {}
    for points in series:
        for p in points:
            ts, value = p["ts"], p["value"]
            if ts not in sums:
                sums[ts] = 0.0
            cur = sums[ts]
            sums[ts] = None if (cur is None or value is None) else cur + value
    return [{"ts": ts, "value": sums[ts]} for ts in sorted(sums)]


def _round_points(points: list[dict]) -> list[dict]:
    return [{"ts": p["ts"], "value": None if p["value"] is None else round(p["value"], 1)} for p in points]


def merge_rooftop(prev: dict[str, list[dict]], fresh: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """Merge a fresh single-interval fetch into the accumulated previous series.

    NEMWEB ROOFTOP_PV/ACTUAL/ publishes only the most recent interval per run.
    We grow the day's series by carrying all previous points forward and
    overwriting / adding the new interval(s) from the fresh fetch.
    """
    out: dict[str, list[dict]] = {}
    for r in set(list(prev) + list(fresh)):
        by_ts: dict[str, dict] = {p["ts"]: p for p in prev.get(r, [])}
        for p in fresh.get(r, []):
            by_ts[p["ts"]] = p  # fresh overwrites prev for same timestamp
        out[r] = sorted(by_ts.values(), key=lambda p: p["ts"])
    return out


# --- Carry-forward -------------------------------------------------------

def carry_forward(prev_path: Path | None, today: str) -> tuple[dict, dict | None]:
    """Reuse the previous file's rooftop actuals and currentForecast.

    Only rooftop points dated ``today`` (AEST) are kept; yesterday's drop
    naturally at day rollover. The forecast is carried as-is; the frontend
    filters to future intervals.
    """
    if not prev_path or not prev_path.exists():
        log.info("no previous file to carry forward from")
        return {}, None
    try:
        prev = json.loads(prev_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("could not read previous file %s: %s", prev_path, exc)
        return {}, None

    out: dict[str, list[dict]] = {}
    prev_regions = prev.get("regions") or {}
    for r in REGIONS:
        points = (prev_regions.get(r) or {}).get("rooftopPv") or []
        today_points = [p for p in points if isinstance(p, dict) and str(p.get("ts", ""))[:10] == today]
        if today_points:
            out[r] = today_points

    forecast = prev.get("currentForecast") or None
    return out, forecast


def carry_forward_rooftop(prev_path: Path | None, today: str) -> dict[str, list[dict]]:
    """Compatibility wrapper returning only carried rooftop actuals."""
    rooftop, _ = carry_forward(prev_path, today)
    return rooftop


# --- Assembly ------------------------------------------------------------

def assemble(
    updated_at: str,
    demand: dict[str, list[dict]],
    rooftop: dict[str, list[dict]],
    current_forecast: dict | None = None,
) -> dict:
    """Merge per-region demand/rooftop into the output object, adding the NEM sum."""
    regions: dict[str, dict] = {}
    for r in REGIONS:
        regions[r] = {
            "demand": _round_points(demand.get(r, [])),
            "rooftopPv": _round_points(rooftop.get(r, [])),
        }
    regions["NEM"] = {
        "demand": _round_points(sum_nem([demand.get(r, []) for r in REGIONS])),
        "rooftopPv": _round_points(sum_nem([rooftop.get(r, []) for r in REGIONS])),
    }
    payload: dict = {"updatedAt": updated_at, "regions": regions}
    if current_forecast is not None:
        payload["currentForecast"] = current_forecast
    return payload


# --- CLI -----------------------------------------------------------------

def _want_rooftop(minute: int, forced: bool) -> bool:
    """Rooftop/forecast fetch gate.

    Kept as a helper for the CLI flag and tests, but currently always true:
    NEMWEB is unauthenticated, and every-run fetches keep rooftop actuals fresh
    when the interval ZIP appears just after a scheduled run.
    """
    return True


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=Path("today-live.json"), help="Output JSON path.")
    p.add_argument("--prev", type=Path, default=None,
                   help="Previous output, to carry rooftop/forecast forward on demand-only runs.")
    p.add_argument("--context-out", type=Path,
                   help="Write the additive system-context product to this path.")
    p.add_argument("--briefing-out", type=Path,
                   help="Write the event model and run-to-run briefing to this path.")
    p.add_argument("--prev-context", type=Path,
                   help="Previous system-context product used for deltas and carry-forward.")
    p.add_argument("--force-rooftop", action="store_true",
                   help="Fetch rooftop/forecasts regardless of the minute-of-hour gate.")
    p.add_argument("--verbose", "-v", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    api_key = os.environ.get("OE_API_KEY")
    if not api_key:
        log.error("OE_API_KEY is not set")
        return 2

    now_aest = datetime.now(AEST)
    today = now_aest.strftime("%Y-%m-%d")
    date_start = now_aest.replace(hour=0, minute=0, second=0, microsecond=0)
    date_end = now_aest

    oe_sess = _oe_session(api_key)
    nem_sess = _nemweb_session()
    oe_requests = 0
    previous_context = _read_optional_json(args.prev_context)

    try:
        # Demand actuals: always fetch from OE (one multi-region request).
        demand_body = _oe_get(oe_sess, DEMAND_PATH, {"metrics": "demand"}, date_start, date_end)
        oe_requests += 1
        demand = parse_regions(demand_body)
        got = [r for r in REGIONS if demand.get(r)]
        if not got:
            log.error("OE returned no demand data for any region")
            return 1
        log.info("demand actuals: %d regions (%s)", len(got), ", ".join(got))

        # Rooftop actuals + forecasts: every ~30 min from NEMWEB, else carry forward.
        # NEMWEB publishes only the most recent interval per file, so we always
        # start from the previous accumulated series and merge the new point in.
        if _want_rooftop(now_aest.minute, args.force_rooftop):
            prev_rooftop, _ = carry_forward(args.prev, today)
            fresh_rooftop = fetch_rooftop_actual_nemweb(nem_sess, today)
            rooftop = merge_rooftop(prev_rooftop, fresh_rooftop)
            d_fc_issued, d_fc = fetch_demand_forecast_nemweb(nem_sess, today)
            r_fc_issued, r_fc = fetch_rooftop_forecast_nemweb(nem_sess, today)
            current_forecast: dict | None = {
                "demand": {"issuedAt": d_fc_issued, "regions": d_fc},
                "rooftopPv": {"issuedAt": r_fc_issued, "regions": r_fc},
            }
            log.info(
                "rooftop/forecast: fetched+merged (minute=%d, forced=%s); "
                "%d rooftop points/region after merge; "
                "demand fcst issued=%s (%d regions), rooftop fcst issued=%s (%d regions)",
                now_aest.minute, args.force_rooftop,
                max((len(v) for v in rooftop.values()), default=0),
                d_fc_issued, len(d_fc), r_fc_issued, len(r_fc),
            )
        else:
            rooftop, current_forecast = carry_forward(args.prev, today)
            log.info(
                "rooftop/forecast: carried forward at minute=%d; %d rooftop region series",
                now_aest.minute, len(rooftop),
            )

    except requests.RequestException as exc:
        log.error("request failed: %s", exc)
        return 1

    updated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = assemble(updated_at, demand, rooftop, current_forecast)
    args.out.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    log.info("wrote %s (updatedAt=%s)", args.out, updated_at)

    # Context products are deliberately independent of the compatibility live
    # payload. A failed context source is carried forward or omitted without
    # preventing the familiar forecast charts from updating.
    if args.context_out or args.briefing_out:
        previous_sources = (previous_context or {}).get("sources") or {}
        sources: dict[str, dict] = {
            "operationalDemand": {
                "updatedAt": updated_at,
                "status": "current",
                "cadence": "5m",
                "source": "OpenElectricity/AEMO DISPATCHREGIONSUM",
            }
        }
        context_errors: list[dict[str, str]] = []

        def source_error(name: str, exc: Exception) -> None:
            message = str(exc)
            context_errors.append({"source": name, "message": message})
            carried = dict(previous_sources.get(name) or {})
            sources[name] = {**carried, "status": "carried-forward", "error": message}
            log.warning("context source %s failed; carrying forward where possible: %s", name, exc)

        previous_areas = ((previous_context or {}).get("rooftopPvAreas") or {}).get("areas") or {}
        fresh_area_actual: dict[str, list[dict]] = {}
        area_forecast = {
            area: block.get("forecast")
            for area, block in previous_areas.items()
            if isinstance(block, dict) and isinstance(block.get("forecast"), dict)
        }
        area_actual_issued: str | None = None
        area_forecast_issued: str | None = None
        try:
            area_actual_issued, tables = _fetch_latest_nemweb_tables(nem_sess, ROOFTOP_ACTUAL_AREA_PATH)
            fresh_area_actual = parse_rooftop_area_actual(tables, today)
            sources["rooftopPvAreaActual"] = {
                "updatedAt": area_actual_issued,
                "status": "current",
                "cadence": "30m",
                "source": "AEMO ROOFTOP_PV ACTUAL_AREA",
            }
        except Exception as exc:
            source_error("rooftopPvAreaActual", exc)
        try:
            area_forecast_issued, tables = _fetch_latest_nemweb_tables(nem_sess, ROOFTOP_FORECAST_AREA_PATH)
            fresh_area_forecast = parse_rooftop_area_forecast(tables, today)
            if fresh_area_forecast:
                area_forecast = fresh_area_forecast
            sources["rooftopPvAreaForecast"] = {
                "updatedAt": area_forecast_issued,
                "status": "current",
                "cadence": "30m",
                "source": "AEMO ROOFTOP_PV FORECAST_AREA",
            }
        except Exception as exc:
            source_error("rooftopPvAreaForecast", exc)

        metadata = _previous_facility_metadata(previous_context)
        facility_updated_at = (
            ((previous_sources.get("facilityMetadata") or {}).get("updatedAt"))
            if isinstance(previous_sources, dict)
            else None
        )
        if not _facility_metadata_is_fresh(previous_context, now_aest):
            try:
                metadata_body = _fetch_facilities(oe_sess)
                oe_requests += 1
                refreshed = parse_facility_metadata(metadata_body)
                if refreshed:
                    metadata = refreshed
                facility_updated_at = updated_at
                sources["facilityMetadata"] = {
                    "updatedAt": facility_updated_at,
                    "status": "current",
                    "cadence": "24h",
                    "source": "OpenElectricity facilities",
                }
            except Exception as exc:
                source_error("facilityMetadata", exc)
        else:
            sources["facilityMetadata"] = {
                "updatedAt": facility_updated_at,
                "status": "cached",
                "cadence": "24h",
                "source": "OpenElectricity facilities",
            }

        duid_scada = (previous_context or {}).get("duidScada") or {"observedAt": None, "assets": []}
        try:
            scada_issued, tables = _fetch_latest_nemweb_tables(nem_sess, DISPATCH_SCADA_PATH)
            parsed_scada = parse_duid_scada(tables, metadata, previous_context)
            if parsed_scada.get("assets"):
                duid_scada = parsed_scada
            sources["duidScada"] = {
                "updatedAt": parsed_scada.get("observedAt") or scada_issued,
                "status": "current",
                "cadence": "5m",
                "source": "AEMO DISPATCH_UNIT_SCADA",
            }
        except Exception as exc:
            source_error("duidScada", exc)

        dispatch_context = (previous_context or {}).get("dispatch") or {
            "observedAt": None,
            "regions": {},
            "bindingConstraints": [],
            "interconnectors": [],
        }
        try:
            dispatch_issued, tables = _fetch_latest_nemweb_tables(nem_sess, DISPATCHIS_PATH)
            parsed_dispatch = parse_dispatch_context(tables)
            if parsed_dispatch.get("observedAt"):
                dispatch_context = parsed_dispatch
            sources["dispatchContext"] = {
                "updatedAt": parsed_dispatch.get("observedAt") or dispatch_issued,
                "status": "current",
                "cadence": "5m",
                "source": "AEMO DISPATCHIS",
            }
        except Exception as exc:
            source_error("dispatchContext", exc)

        reserve_context = (previous_context or {}).get("reserve") or {
            "runAt": None,
            "horizonHours": 24,
            "regions": {},
        }
        try:
            reserve_issued, tables = _fetch_latest_nemweb_tables(nem_sess, PDPASA_PATH)
            parsed_reserve = parse_reserve_context(tables, now_aest)
            if parsed_reserve.get("regions"):
                reserve_context = parsed_reserve
            sources["reserve"] = {
                "updatedAt": parsed_reserve.get("runAt") or reserve_issued,
                "status": "current",
                "cadence": "30m",
                "source": "AEMO PDPASA LOR run",
            }
        except Exception as exc:
            source_error("reserve", exc)

        area_blocks = merge_area_actuals(previous_context, fresh_area_actual, today)
        for area, forecast in area_forecast.items():
            area_blocks.setdefault(area, {"areaId": area, "actual": []})["forecast"] = forecast

        live_demand = {region: values["demand"] for region, values in payload["regions"].items()}
        live_rooftop = {region: values["rooftopPv"] for region, values in payload["regions"].items()}
        system_context = {
            "schemaVersion": "1.0.0",
            "updatedAt": updated_at,
            "tradingDate": today,
            "sources": sources,
            "regions": build_region_metrics(live_demand, live_rooftop),
            "currentForecast": current_forecast or {},
            "rooftopPvAreas": {
                "actualIssuedAt": area_actual_issued,
                "forecastIssuedAt": area_forecast_issued,
                "areas": area_blocks,
            },
            "duidScada": duid_scada,
            "dispatch": dispatch_context,
            "reserve": reserve_context,
            "quality": {"status": "partial" if context_errors else "complete", "errors": context_errors},
        }
        briefing = build_briefing(system_context, previous_context)
        if args.context_out:
            args.context_out.write_text(json.dumps(system_context, separators=(",", ":")), encoding="utf-8")
            log.info("wrote %s", args.context_out)
        if args.briefing_out:
            args.briefing_out.write_text(json.dumps(briefing, separators=(",", ":")), encoding="utf-8")
            log.info("wrote %s (%d events)", args.briefing_out, len(briefing["events"]))

    # Demand uses one OE request every run. Facility metadata adds at most one
    # request per day, keeping the existing free-tier budget comfortably bounded.
    log.info("OE requests this run: %d", oe_requests)
    if oe_requests > 2:
        log.error("OE request budget exceeded (%d > 2)", oe_requests)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
