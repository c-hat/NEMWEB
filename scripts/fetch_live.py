#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.32"]
# ///
"""Fetch today's live NEM demand and rooftop PV from the OpenElectricity API,
and pull the latest NEMWEB pre-dispatch forecast trail.

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
      "forecasts": [
        {
          "issuedAt": "2026-06-03T10:30+10:00",
          "regions": {
            "NSW1": {
              "demand": {"intervals": [...], "poe10": [...], "poe50": [...], "poe90": [...]},
              "rooftopPv": {"intervals": [...], "poe10": [...], "poe50": [...], "poe90": [...]}
            },
            ... VIC1, QLD1, SA1, TAS1 ...
          }
        },
        ... up to 6 entries, oldest first, last 3 hours ...
      ]
    }

Rate-limit budget (OE free tier = 500 requests/day):
  - Demand: ONE multi-region request per run.
  - Rooftop: ONE multi-region request ~every 30 min; other runs carry forward.
  - NEMWEB forecasts: 2 directory-listing GETs + at most 2 file downloads per run.
  - No NEMWEB rate limit; OE budget is at most 2 requests per run.

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


log = logging.getLogger("fetch_live")

# OE publishes NEM data in network time, which is AEST (UTC+10, no DST).
AEST = timezone(timedelta(hours=10))

OE_BASE = "https://api.openelectricity.org.au"
# 5-minute operational demand (DISPATCHREGIONSUM.TOTALDEMAND), all regions.
DEMAND_PATH = "/v4/market/network/NEM"
# Rooftop PV. We request energy (not power): for rooftop-by-region OE publishes
# energy ~75 min fresher than power. Energy is MWh per 5-min interval, so we
# convert to average MW (x12) to match the demand/forecast units.
ROOFTOP_PATH = "/v4/data/network/NEM"

REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"]

USER_AGENT = "nemweb-live-fetch/0.1 (+https://github.com/c-hat/nemweb)"

# Interpolate within a native rooftop interval, not across long flat runs.
INTERP_MAX_GAP_MS = 35 * 60_000

# NEMWEB pre-dispatch forecast directories (relative to nemweb.com.au).
_NEMWEB_BASE = "https://nemweb.com.au"
_FORECAST_DEMAND_DIR = "Reports/Current/Operational_Demand/FORECAST_HH"
_FORECAST_ROOFTOP_DIR = "Reports/Current/ROOFTOP_PV/FORECAST"

# Retain forecasts issued within this window of now.
_FORECAST_RETENTION_H = 3

# NEMWEB filenames embed a 12- or 14-digit timestamp: 202606031030 or 20260603103000.
_TS_RE = re.compile(r"(\d{12,14})")
# Apache directory index href capture.
_HREF_RE = re.compile(r'<a\s+href="([^"?][^"]*)"', re.IGNORECASE)


# --- OE HTTP ----------------------------------------------------------------

def _session(api_key: str) -> requests.Session:
    """A session with auth, a polite UA, and bounded retries on transient 5xx.

    401/403 are NOT retried — an auth/key problem should fail fast and loud.
    """
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


# --- OE Parsing -------------------------------------------------------------

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


def _parse_ms(ts: str) -> int:
    """Epoch ms for a normalised (offset-aware) timestamp."""
    return int(datetime.fromisoformat(ts).timestamp() * 1000)


def smooth_held(points: list[dict]) -> list[dict]:
    """Interpolate OE's held rooftop readings into a smooth line."""
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


def build_rooftop(body: dict) -> dict[str, list[dict]]:
    """Per-region rooftop: energy (MWh/5min) -> average MW (x12), then smoothed."""
    out: dict[str, list[dict]] = {}
    for region, points in parse_regions(body).items():
        mw = [{"ts": p["ts"], "value": None if p["value"] is None else p["value"] * 12} for p in points]
        out[region] = smooth_held(mw)
    return out


def sum_nem(series: list[list[dict]]) -> list[dict]:
    """Sum several regions' series by timestamp; null in any region propagates."""
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


def assemble(
    updated_at: str,
    demand: dict[str, list[dict]],
    rooftop: dict[str, list[dict]],
    forecasts: list[dict] | None = None,
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
    return {"updatedAt": updated_at, "regions": regions, "forecasts": forecasts or []}


# --- Carry-forward (OE actuals) ---------------------------------------------

def carry_forward_rooftop(prev_path: Path | None, today: str) -> dict[str, list[dict]]:
    """Reuse the previous file's rooftop on demand-only runs."""
    if not prev_path or not prev_path.exists():
        log.info("no previous file to carry rooftop forward from")
        return {}
    try:
        prev = json.loads(prev_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("could not read previous file %s: %s", prev_path, exc)
        return {}
    out: dict[str, list[dict]] = {}
    prev_regions = prev.get("regions") or {}
    for r in REGIONS:
        points = (prev_regions.get(r) or {}).get("rooftopPv") or []
        today_points = [p for p in points if isinstance(p, dict) and str(p.get("ts", ""))[:10] == today]
        if today_points:
            out[r] = today_points
    return out


def carry_forward_forecasts(prev_path: Path | None, today: str) -> list[dict]:
    """Load the forecasts array from the previous file, keeping only today's entries."""
    if not prev_path or not prev_path.exists():
        return []
    try:
        prev = json.loads(prev_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("could not read previous file for forecasts %s: %s", prev_path, exc)
        return []
    forecasts = prev.get("forecasts") or []
    return [
        f for f in forecasts
        if isinstance(f, dict) and str(f.get("issuedAt", ""))[:10] == today
    ]


# --- NEMWEB forecast helpers ------------------------------------------------

def _nemweb_session() -> requests.Session:
    """Unauthenticated session for NEMWEB public file downloads."""
    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    retry = Retry(
        total=4,
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


def _parse_file_ts(filename: str) -> datetime | None:
    """Extract the YYYYMMDDHHMM[SS] timestamp from a NEMWEB filename, return AEST."""
    m = _TS_RE.search(filename)
    if not m:
        return None
    s = m.group(1)
    try:
        if len(s) >= 14:
            return datetime.strptime(s[:14], "%Y%m%d%H%M%S").replace(tzinfo=AEST)
        return datetime.strptime(s[:12], "%Y%m%d%H%M").replace(tzinfo=AEST)
    except ValueError:
        return None


def _list_dir(session: requests.Session, url: str) -> list[tuple[str, str, datetime | None]]:
    """List .zip files in a NEMWEB Apache directory index.

    Returns (filename, absolute_url, aest_timestamp) for each ZIP entry found.
    """
    if not url.endswith("/"):
        url += "/"
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    out: list[tuple[str, str, datetime | None]] = []
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
        out.append((filename, urljoin(url, href), _parse_file_ts(filename)))
    return out


def _parse_aemo_mms(text: str) -> dict[str, tuple[list[str], list[list[str]]]]:
    """Parse AEMO MMS CSV text into {table_key: (headers, data_rows)}.

    AEMO MMS format: C = comment, I = header, D = data. Each I row defines
    a new table; subsequent D rows belong to that table until the next I row.
    """
    reader = csv.reader(io.StringIO(text))
    tables: dict[str, tuple[list[str], list[list[str]]]] = {}
    current: str | None = None
    for row in reader:
        if not row:
            continue
        marker = row[0]
        if marker == "I" and len(row) >= 5:
            report_type, table_name = row[1].strip(), row[2].strip()
            current = f"{report_type}_{table_name}" if table_name else report_type
            tables[current] = (row[4:], [])
        elif marker == "D" and current is not None:
            tables[current][1].append(row[4:])
    return tables


def _read_zip(data: bytes) -> dict[str, tuple[list[str], list[list[str]]]]:
    """Open a NEMWEB ZIP (may contain nested ZIPs) and return merged AEMO MMS tables."""
    merged: dict[str, tuple[list[str], list[list[str]]]] = {}

    def _add_csv(raw: bytes) -> None:
        text = raw.decode("utf-8", errors="replace")
        for key, (hdrs, rows) in _parse_aemo_mms(text).items():
            if key in merged:
                merged[key][1].extend(rows)
            else:
                merged[key] = (hdrs, list(rows))

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            name = info.filename.lower()
            if name.endswith(".csv"):
                _add_csv(zf.read(info))
            elif name.endswith(".zip"):
                with zipfile.ZipFile(io.BytesIO(zf.read(info))) as zf2:
                    for info2 in zf2.infolist():
                        if info2.filename.lower().endswith(".csv"):
                            _add_csv(zf2.read(info2))
    return merged


def _parse_aemo_dt_str(s: str) -> datetime | None:
    """Parse an AEMO datetime string like '2026/05/28 00:30:00' to AEST."""
    s = s.strip().strip('"')
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=AEST)
        except ValueError:
            pass
    return None


def _fmt_aest(dt: datetime) -> str:
    """Format an AEST datetime as 'YYYY-MM-DDTHH:MM+10:00' (no seconds)."""
    return dt.strftime("%Y-%m-%dT%H:%M+10:00")


def _demand_series(
    tables: dict[str, tuple[list[str], list[list[str]]]],
    window_start: datetime,
    window_end: datetime,
) -> dict[str, dict]:
    """Extract per-region demand forecast series filtered to [window_start, window_end].

    Returns {region: {intervals, poe10, poe50, poe90}}.
    """
    headers: list[str] | None = None
    rows: list[list[str]] | None = None
    for _key, (h, r) in tables.items():
        h_upper = {c.upper() for c in h}
        if "OPERATIONAL_DEMAND_POE50" in h_upper and "REGIONID" in h_upper:
            headers, rows = h, r
            break
    if not headers or not rows:
        return {}

    col = {h.upper(): i for i, h in enumerate(headers)}
    needed = {"REGIONID", "INTERVAL_DATETIME",
               "OPERATIONAL_DEMAND_POE10", "OPERATIONAL_DEMAND_POE50", "OPERATIONAL_DEMAND_POE90"}
    if not needed <= col.keys():
        log.warning("demand forecast table missing columns; have: %s", list(col))
        return {}

    by_region: dict[str, dict[datetime, tuple[float, float, float]]] = {r: {} for r in REGIONS}
    for row in rows:
        if len(row) < len(headers):
            row = row + [""] * (len(headers) - len(row))
        region = row[col["REGIONID"]].strip()
        if region not in REGIONS:
            continue
        dt = _parse_aemo_dt_str(row[col["INTERVAL_DATETIME"]])
        if dt is None or not (window_start <= dt <= window_end):
            continue
        try:
            p10 = float(row[col["OPERATIONAL_DEMAND_POE10"]])
            p50 = float(row[col["OPERATIONAL_DEMAND_POE50"]])
            p90 = float(row[col["OPERATIONAL_DEMAND_POE90"]])
        except (ValueError, IndexError):
            continue
        by_region[region][dt] = (p10, p50, p90)

    result: dict[str, dict] = {}
    for region in REGIONS:
        pts = sorted(by_region[region].items())
        if not pts:
            continue
        result[region] = {
            "intervals": [_fmt_aest(t) for t, _ in pts],
            "poe10": [round(v[0], 1) for _, v in pts],
            "poe50": [round(v[1], 1) for _, v in pts],
            "poe90": [round(v[2], 1) for _, v in pts],
        }
    return result


def _rooftop_series(
    tables: dict[str, tuple[list[str], list[list[str]]]],
    window_start: datetime,
    window_end: datetime,
) -> dict[str, dict]:
    """Extract per-region rooftop PV forecast series filtered to [window_start, window_end].

    POE convention matches the rest of the app: poe10 = HIGH band (POWERPOEHIGH),
    poe90 = LOW band (POWERPOELOW).
    """
    headers: list[str] | None = None
    rows: list[list[str]] | None = None
    for _key, (h, r) in tables.items():
        h_upper = {c.upper() for c in h}
        if "POWERPOE50" in h_upper and "REGIONID" in h_upper:
            headers, rows = h, r
            break
    if not headers or not rows:
        return {}

    col = {h.upper(): i for i, h in enumerate(headers)}
    needed = {"REGIONID", "INTERVAL_DATETIME", "POWERPOELOW", "POWERPOE50", "POWERPOEHIGH"}
    if not needed <= col.keys():
        log.warning("rooftop forecast table missing columns; have: %s", list(col))
        return {}

    by_region: dict[str, dict[datetime, tuple[float, float, float]]] = {r: {} for r in REGIONS}
    for row in rows:
        if len(row) < len(headers):
            row = row + [""] * (len(headers) - len(row))
        region = row[col["REGIONID"]].strip()
        if region not in REGIONS:
            continue
        dt = _parse_aemo_dt_str(row[col["INTERVAL_DATETIME"]])
        if dt is None or not (window_start <= dt <= window_end):
            continue
        try:
            p10 = float(row[col["POWERPOEHIGH"]])
            p50 = float(row[col["POWERPOE50"]])
            p90 = float(row[col["POWERPOELOW"]])
        except (ValueError, IndexError):
            continue
        by_region[region][dt] = (p10, p50, p90)

    result: dict[str, dict] = {}
    for region in REGIONS:
        pts = sorted(by_region[region].items())
        if not pts:
            continue
        result[region] = {
            "intervals": [_fmt_aest(t) for t, _ in pts],
            "poe10": [round(v[0], 1) for _, v in pts],
            "poe50": [round(v[1], 1) for _, v in pts],
            "poe90": [round(v[2], 1) for _, v in pts],
        }
    return result


def fetch_nemweb_forecasts(
    prev_forecasts: list[dict],
    now_aest: datetime,
) -> list[dict]:
    """Fetch any new NEMWEB pre-dispatch forecasts and return the updated list.

    Per run:
    - 2 directory-listing GETs (demand + rooftop dirs)
    - At most 1 demand file download + 1 rooftop file download (new files only)

    Returns a list sorted ascending by issuedAt, trimmed to _FORECAST_RETENTION_H.
    """
    today_str = now_aest.strftime("%Y-%m-%d")
    # Trading day window: 00:30 through 24:00 (= next day 00:00)
    today_midnight = now_aest.replace(hour=0, minute=0, second=0, microsecond=0)
    window_start = today_midnight + timedelta(minutes=30)
    window_end = today_midnight + timedelta(days=1)  # 24:00 = next-day 00:00

    # Determine the most recently fetched forecast's issue time.
    latest_known: datetime | None = None
    for f in prev_forecasts:
        try:
            dt = datetime.fromisoformat(f["issuedAt"])
            if latest_known is None or dt > latest_known:
                latest_known = dt
        except (KeyError, ValueError):
            pass

    sess = _nemweb_session()

    demand_url = f"{_NEMWEB_BASE}/{_FORECAST_DEMAND_DIR}/"
    rooftop_url = f"{_NEMWEB_BASE}/{_FORECAST_ROOFTOP_DIR}/"

    log.info("listing NEMWEB demand forecast dir")
    demand_entries = _list_dir(sess, demand_url)
    log.info("listing NEMWEB rooftop forecast dir")
    rooftop_entries = _list_dir(sess, rooftop_url)

    # Index rooftop files by their filename timestamp for matching.
    rooftop_by_ts: dict[datetime, tuple[str, str]] = {}
    for fname, url, ts in rooftop_entries:
        if ts is not None:
            rooftop_by_ts[ts] = (fname, url)

    # New demand files = from today, newer than latest_known.
    new_demand = [
        (fname, url, ts)
        for fname, url, ts in demand_entries
        if ts is not None
        and ts.strftime("%Y-%m-%d") == today_str
        and (latest_known is None or ts > latest_known)
    ]
    new_demand.sort(key=lambda x: x[2])  # type: ignore[arg-type]

    log.info(
        "found %d new demand forecast file(s) since %s",
        len(new_demand),
        latest_known.isoformat() if latest_known else "start of day",
    )

    new_entries: list[dict] = []
    for fname, url, ts in new_demand:
        log.info("downloading demand forecast: %s", fname)
        try:
            dresp = sess.get(url, timeout=120)
            dresp.raise_for_status()
            demand_tables = _read_zip(dresp.content)
        except Exception as exc:
            log.warning("failed to download/parse %s: %s", fname, exc)
            continue

        d_series = _demand_series(demand_tables, window_start, window_end)
        if not d_series:
            log.warning("no today-intervals found in demand forecast %s", fname)
            continue

        # Match rooftop file: same filename timestamp, within 5-minute tolerance.
        rt_series: dict[str, dict] = {}
        best_rt = min(
            (rt_ts for rt_ts in rooftop_by_ts if abs((rt_ts - ts).total_seconds()) <= 300),  # type: ignore[operator]
            key=lambda rt_ts: abs((rt_ts - ts).total_seconds()),  # type: ignore[operator]
            default=None,
        )
        if best_rt is not None:
            rt_fname, rt_url = rooftop_by_ts[best_rt]
            log.info("downloading rooftop forecast: %s", rt_fname)
            try:
                rresp = sess.get(rt_url, timeout=120)
                rresp.raise_for_status()
                rooftop_tables = _read_zip(rresp.content)
                rt_series = _rooftop_series(rooftop_tables, window_start, window_end)
            except Exception as exc:
                log.warning("failed to download/parse rooftop %s: %s", rt_fname, exc)
        else:
            log.warning("no matching rooftop file for demand forecast at %s", ts.isoformat())  # type: ignore[union-attr]

        issued_at = _fmt_aest(ts)  # type: ignore[arg-type]
        regions_out: dict[str, dict] = {}
        for region in REGIONS:
            entry: dict[str, dict] = {}
            if region in d_series:
                entry["demand"] = d_series[region]
            if region in rt_series:
                entry["rooftopPv"] = rt_series[region]
            if entry:
                regions_out[region] = entry

        if regions_out:
            new_entries.append({"issuedAt": issued_at, "regions": regions_out})
            log.info("added forecast entry issuedAt=%s (%d regions)", issued_at, len(regions_out))

    # Merge and trim.
    all_forecasts = list(prev_forecasts) + new_entries
    cutoff = now_aest - timedelta(hours=_FORECAST_RETENTION_H)
    all_forecasts = [
        f for f in all_forecasts
        if datetime.fromisoformat(f["issuedAt"]) >= cutoff
    ]
    all_forecasts.sort(key=lambda f: f["issuedAt"])

    log.info(
        "forecasts: %d entries (cutoff %s)",
        len(all_forecasts),
        cutoff.strftime("%H:%M"),
    )
    return all_forecasts


# --- CLI -----------------------------------------------------------------

def _want_rooftop(minute: int, forced: bool) -> bool:
    """Rooftop fetch gate: ~every 30 min (minute-of-hour in {0-9, 30-39})."""
    return forced or minute < 10 or 30 <= minute < 40


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=Path("today-live.json"), help="Output JSON path.")
    p.add_argument("--prev", type=Path, default=None,
                   help="Previous output, to carry rooftop and forecasts forward.")
    p.add_argument("--force-rooftop", action="store_true",
                   help="Fetch rooftop regardless of the minute-of-hour gate.")
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

    session = _session(api_key)
    requests_made = 0

    try:
        # Demand: always, one multi-region request.
        demand_body = _oe_get(session, DEMAND_PATH, {"metrics": "demand"}, date_start, date_end)
        requests_made += 1
        demand = parse_regions(demand_body)
        got = [r for r in REGIONS if demand.get(r)]
        if not got:
            log.error("OE returned no demand data for any region")
            return 1
        log.info("demand: %d regions (%s)", len(got), ", ".join(got))

        # Rooftop: gated to ~every 30 min, else carried forward.
        if _want_rooftop(now_aest.minute, args.force_rooftop):
            rooftop_body = _oe_get(
                session, ROOFTOP_PATH, {"metrics": "energy", "fueltech": "solar_rooftop"}, date_start, date_end
            )
            requests_made += 1
            rooftop = build_rooftop(rooftop_body)
            log.info("rooftop: fetched fresh (minute=%d, forced=%s; %d regions)",
                     now_aest.minute, args.force_rooftop, len(rooftop))
        else:
            rooftop = carry_forward_rooftop(args.prev, today)
            log.info("rooftop: skipped at minute=%d; carried %d region series forward",
                     now_aest.minute, len(rooftop))
    except requests.RequestException as exc:
        log.error("OE request failed: %s", exc)
        return 1

    # OE budget guard: by construction this is 1 or 2; anything more is a bug.
    log.info("OE requests this run: %d", requests_made)
    if requests_made > 2:
        log.error("OE request budget exceeded (%d > 2) — aborting without writing", requests_made)
        return 1

    # NEMWEB pre-dispatch forecast trail (unauthenticated public downloads, no OE budget impact).
    prev_forecasts = carry_forward_forecasts(args.prev, today)
    try:
        forecasts = fetch_nemweb_forecasts(prev_forecasts, now_aest)
    except Exception as exc:
        log.warning("NEMWEB forecast fetch failed (%s); keeping %d carried-forward entries",
                    exc, len(prev_forecasts))
        forecasts = prev_forecasts

    updated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = assemble(updated_at, demand, rooftop, forecasts)
    args.out.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("wrote %s (updatedAt=%s, %d forecast entries)", args.out, updated_at, len(forecasts))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
