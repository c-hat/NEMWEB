#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.32"]
# ///
"""Fetch today's live NEM demand and rooftop PV from the OpenElectricity API.

Writes a single JSON file (default ``today-live.json``) that the frontend reads
over ``raw.githubusercontent.com`` from the force-pushed ``live-data`` branch.
This replaces the Cloudflare Worker proxy: the scheduled ``live-data`` GitHub
Action runs this script and publishes the output, so the static site never has
to reach a third-party origin (which corporate firewalls may block).

Output shape::

    {
      "updatedAt": "2026-06-03T04:10:07Z",          # UTC, when this run wrote the file
      "regions": {
        "NSW1": { "demand": [{"ts": "...", "value": 7123.4}, ...],
                  "rooftopPv": [{"ts": "...", "value": 812.0}, ...] },
        ... VIC1, QLD1, SA1, TAS1 ...,
        "NEM":  { "demand": [...], "rooftopPv": [...] }   # summed across regions
      }
    }

Rate-limit budget (OE free tier = 500 requests/day):
  - Demand: ONE multi-region request per run (all five regions in one call via
    ``primary_grouping=network_region`` with no ``network_region`` filter).
  - Rooftop: ONE multi-region request, but only on runs whose minute-of-hour is
    in {0-9, 30-39} (i.e. ~every 30 min); other runs carry rooftop forward from
    the previous file (``--prev``). ``--force-rooftop`` overrides the gate.
  - So a run makes 1 or 2 OE requests. The count is logged and the run aborts if
    it ever exceeds 2.

Usage::

    OE_API_KEY=... uv run scripts/fetch_live.py --out today-live.json \
        --prev prev-live.json [--force-rooftop] [-v]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

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


# --- HTTP ----------------------------------------------------------------

def _session(api_key: str) -> requests.Session:
    """A session with auth, a polite UA, and bounded retries on transient 5xx.

    401/403 are NOT retried — an auth/key problem should fail fast and loud.
    Retries here re-hit OE, but only on transient failures, so they don't blow
    the request budget under normal operation.
    """
    s = requests.Session()
    s.headers.update(
        {
            "Authorization": f"Bearer {api_key}",
            "User-Agent": USER_AGENT,
            # Ask any CDN in front of OE not to serve a cached body.
            "Cache-Control": "no-cache",
        }
    )
    retry = Retry(
        total=3,
        backoff_factor=1.0,  # ~1, 2, 4s between attempts
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
        "primary_grouping": "network_region",  # one result per region; no region filter
        "date_start": date_start.strftime("%Y-%m-%dT%H:%M:%S"),  # OE wants naive AEST
        "date_end": date_end.strftime("%Y-%m-%dT%H:%M:%S"),
        **extra_params,
    }
    resp = session.get(OE_BASE + path, params=params, timeout=60)
    if resp.status_code in (401, 403):
        log.error("OE returned %s — check the OE_API_KEY secret", resp.status_code)
    resp.raise_for_status()
    return resp.json()


# --- Parsing -------------------------------------------------------------

def _results(body: dict) -> list[dict]:
    """The per-group result objects: body.data[0].results, defensively."""
    if not isinstance(body, dict):
        return []
    data = body.get("data") or []
    if not data or not isinstance(data, list):
        return []
    return data[0].get("results") or []


def _region_of(result: dict) -> str | None:
    """Find which NEM region a result belongs to, from its columns or name.

    Robust to OE's exact grouping key (network_region / network_region_id /
    embedded in the series name) by scanning for a known region code.
    """
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
    """Normalise an OE timestamp to AEST ISO with an explicit +10:00 offset.

    OE returns network-time stamps; normalising removes any ambiguity for the
    frontend's Date.parse regardless of the viewer's timezone. Naive stamps are
    assumed AEST; offset/Z stamps are converted to AEST.
    """
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return ts  # pass through anything unexpected rather than dropping it
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
    """Interpolate OE's held rooftop readings into a smooth line.

    OE serves rooftop as 30-min (native ASEFS2) readings held flat across the
    5-min slots. Linearly interpolate between consecutive anchor readings (where
    the value changes) within a native interval; hold across long flat runs
    (e.g. overnight zeros). Ports the Worker's smoothing so the chart is
    unchanged. Nulls are preserved.
    """
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
    """Sum several regions' series by timestamp; an interval null in any region is null."""
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


def assemble(updated_at: str, demand: dict[str, list[dict]], rooftop: dict[str, list[dict]]) -> dict:
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
    return {"updatedAt": updated_at, "regions": regions}


# --- Carry-forward -------------------------------------------------------

def carry_forward_rooftop(prev_path: Path | None, today: str) -> dict[str, list[dict]]:
    """Reuse the previous file's rooftop on demand-only runs.

    Only points dated ``today`` (AEST) are kept, so a day rollover naturally
    drops yesterday's rooftop (it returns until the next rooftop-minute run).
    """
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


# --- CLI -----------------------------------------------------------------

def _want_rooftop(minute: int, forced: bool) -> bool:
    """Rooftop fetch gate: ~every 30 min (minute-of-hour in {0-9, 30-39})."""
    return forced or minute < 10 or 30 <= minute < 40


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", type=Path, default=Path("today-live.json"), help="Output JSON path.")
    p.add_argument("--prev", type=Path, default=None,
                   help="Previous output, to carry rooftop forward on demand-only runs.")
    p.add_argument("--force-rooftop", action="store_true",
                   help="Fetch rooftop regardless of the minute-of-hour gate (manual testing).")
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

    # Budget guard: by construction this is 1 or 2; anything more is a bug.
    log.info("OE requests this run: %d", requests_made)
    if requests_made > 2:
        log.error("request budget exceeded (%d > 2) — aborting without writing", requests_made)
        return 1

    updated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = assemble(updated_at, demand, rooftop)
    args.out.write_text(json.dumps(payload, separators=(",", ":")))
    log.info("wrote %s (updatedAt=%s)", args.out, updated_at)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
