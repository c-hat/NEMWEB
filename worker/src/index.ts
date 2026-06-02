/**
 * nemweb-proxy — Cloudflare Worker.
 *
 * Thin caching proxy between the NEMWEB tracker frontend and the
 * OpenElectricity (OE) API. It exists for two reasons:
 *
 *   1. Hide the OE API key (held as the `OE_API_KEY` Wrangler secret) — the
 *      static frontend never sees it.
 *   2. Cache responses at Cloudflare's edge so every visitor shares fetched
 *      data, keeping us under OE's 500 req/day free-tier limit regardless of
 *      how many tabs are open.
 *
 * Endpoints:
 *   GET /demand?region={NSW1|...|NEM}&from={ISO}&to={ISO}
 *     → 5-minute operational demand (DISPATCHREGIONSUM.TOTALDEMAND).
 *   GET /rooftop?region=...&from=...&to=...
 *     → 30-minute rooftop PV (native ASEFS2 cadence, not OE's 5-min gap-fill).
 *
 *   For NEM we fan out to the five regions and sum server-side, so the
 *   aggregate costs a single shared cache entry, not five.
 *
 * Both request shapes are verified against live OE. `?debug=raw` (single
 * region) returns the truncated upstream body if OE's schema ever shifts and a
 * SPECS `url`/`parse` needs re-checking.
 */

export interface Env {
  OE_API_KEY: string;
}

const OE_BASE = "https://api.openelectricity.org.au";
const REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"];

// CORS allow-list. No wildcard: GitHub Pages origin + localhost (any port) for dev.
const ALLOWED_ORIGIN = [/^https:\/\/c-hat\.github\.io$/, /^http:\/\/localhost(:\d+)?$/];

function corsHeaders(origin: string | null): Record<string, string> {
  const ok = !!origin && ALLOWED_ORIGIN.some((re) => re.test(origin));
  return {
    "access-control-allow-origin": ok ? (origin as string) : "null",
    "access-control-allow-methods": "GET, OPTIONS",
    vary: "Origin",
  };
}

/** Return a copy of `res` with the per-request headers applied (cache entries are stored origin-agnostic). */
function withHeaders(res: Response, headers: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Point {
  ts: string;
  value: number | null;
}

type Row = [string, number | null];

// OE requires timezone-naive timestamps in network (AEST) time. Our inputs are
// already AEST (+10:00), so strip the trailing offset (or a Z) and pass the
// wall-clock part through unchanged.
function toNetworkNaive(iso: string): string {
  return iso.replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
}

function rangeParams(from: string, to: string): string {
  return `date_start=${encodeURIComponent(toNetworkNaive(from))}&date_end=${encodeURIComponent(toNetworkNaive(to))}`;
}

function rowsToPoints(rows: Row[]): Point[] {
  return rows.map(([ts, value]) => ({ ts, value: value ?? null }));
}

const INTERP_MAX_GAP_MS = 35 * 60_000; // interpolate within a native interval, not across long flats

/**
 * OE serves rooftop as 30-min (or 15-min) readings held flat across the 5-min
 * slots. Reproduce OE's own display: linearly interpolate between consecutive
 * anchor readings (where the value changes) within a native interval, hold
 * across long flat runs (overnight 0s), and drop the trailing held-repeat — the
 * unpublished lag tail where OE just forward-fills the latest reading.
 */
function smoothHeld(points: Point[]): Point[] {
  const anchors: { ms: number; v: number }[] = [];
  for (const p of points) {
    if (p.value == null) continue;
    if (anchors.length === 0 || anchors[anchors.length - 1].v !== p.value) {
      anchors.push({ ms: Date.parse(p.ts), v: p.value });
    }
  }
  if (anchors.length < 2) return points;
  const lastAnchorMs = anchors[anchors.length - 1].ms;
  const out: Point[] = [];
  let a = 0;
  for (const p of points) {
    const ms = Date.parse(p.ts);
    if (ms > lastAnchorMs) break; // drop the held-repeat lag tail
    if (p.value == null) {
      out.push(p);
      continue;
    }
    while (a < anchors.length - 1 && anchors[a + 1].ms <= ms) a++;
    const left = anchors[a];
    const right = anchors[a + 1];
    if (!right || ms <= left.ms || right.ms - left.ms > INTERP_MAX_GAP_MS) {
      out.push({ ts: p.ts, value: left.v });
    } else {
      const f = (ms - left.ms) / (right.ms - left.ms);
      out.push({ ts: p.ts, value: left.v + (right.v - left.v) * f });
    }
  }
  return out;
}

interface MetricSpec {
  metric: string;
  interval: string;
  unit: string;
  ttl: number; // edge-cache seconds; just under the poll cycle
  url: (region: string, from: string, to: string) => string;
  parse: (body: any) => Point[];
}

const SPECS: Record<string, MetricSpec> = {
  // Verified against live OE: data[0].results[0].data = [[ts, value], ...].
  demand: {
    metric: "demand",
    interval: "5m",
    unit: "MW",
    ttl: 240,
    url: (region, from, to) =>
      `${OE_BASE}/v4/market/network/NEM?metrics=demand&interval=5m` +
      `&primary_grouping=network_region&network_region=${region}&${rangeParams(from, to)}`,
    parse: (body) => rowsToPoints(body?.data?.[0]?.results?.[0]?.data ?? []),
  },
  // Rooftop PV. We query metrics=energy (not power): for rooftop-by-region OE
  // publishes energy ~75 min fresher than power. Energy is MWh per 5-min
  // interval, so we convert to average MW (×12) to match the demand/forecast
  // units. Filtered to fueltech=solar_rooftop. Still 30-min underlying, held
  // across 5-min slots, so smoothHeld() interpolates to match OE's display.
  rooftop: {
    metric: "rooftop",
    interval: "5m",
    unit: "MW",
    ttl: 240,
    url: (region, from, to) =>
      `${OE_BASE}/v4/data/network/NEM?metrics=energy&interval=5m` +
      `&primary_grouping=network_region&network_region=${region}` +
      `&fueltech=solar_rooftop&${rangeParams(from, to)}`,
    parse: (body) => {
      const results: any[] = body?.data?.[0]?.results ?? [];
      // Filtered to one fueltech, so match the rooftop series by name, falling
      // back to the sole result — but never to results[0] among many (battery).
      const pick =
        results.find((r) =>
          /rooftop/i.test(String(r?.columns?.fueltech ?? r?.columns?.fueltech_id ?? r?.name ?? "")),
        ) ?? (results.length === 1 ? results[0] : undefined);
      // MWh per 5-min interval → average MW.
      const points = rowsToPoints(pick?.data ?? []).map((p) => ({
        ts: p.ts,
        value: p.value == null ? null : p.value * 12,
      }));
      return smoothHeld(points);
    },
  },
};

async function oeFetch(env: Env, spec: MetricSpec, region: string, from: string, to: string): Promise<Point[]> {
  const res = await fetch(spec.url(region, from, to), {
    headers: { authorization: `Bearer ${env.OE_API_KEY}` },
    cache: "no-store",
  });
  if (res.status === 401 || res.status === 403) throw new Error("oe-auth");
  if (!res.ok) throw new Error("oe-upstream");
  return spec.parse(await res.json());
}

/** Sum several regions' series by timestamp; an interval missing from any region is null. */
function sumByTimestamp(series: Point[][]): Point[] {
  const sums = new Map<string, number | null>();
  const order: string[] = [];
  for (const points of series) {
    for (const { ts, value } of points) {
      if (!sums.has(ts)) {
        sums.set(ts, 0);
        order.push(ts);
      }
      const cur = sums.get(ts)!;
      sums.set(ts, cur === null || value === null ? null : cur + value);
    }
  }
  return order.map((ts) => ({ ts, value: sums.get(ts)! }));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const headers = corsHeaders(request.headers.get("Origin"));
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    const spec = SPECS[url.pathname.slice(1)]; // "/demand" → "demand"
    if (!spec) return jsonResponse({ error: "not found" }, 404, headers);

    const region = url.searchParams.get("region") ?? "";
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if ((region !== "NEM" && !REGIONS.includes(region)) || !from || !to) {
      return jsonResponse({ error: "region, from and to are required" }, 400, headers);
    }

    // Diagnostic: summarise the upstream fueltech series (uncached — fetched
    // direct from OE each call). `lastReal` = the latest reading before any
    // forward-filled tail, so it reveals OE's true rooftop freshness.
    if (url.searchParams.get("debug") && region !== "NEM") {
      const res = await fetch(spec.url(region, from, to), {
        headers: { authorization: `Bearer ${env.OE_API_KEY}` },
        cache: "no-store",
      });
      const body: any = await res.json().catch(() => null);
      const results: any[] = body?.data?.[0]?.results ?? [];
      const lastReal = (data: Row[] | undefined) => {
        let anchor: Row | null = null;
        let prev: number | null | undefined;
        for (const row of data ?? []) {
          const v = row?.[1];
          if (v == null) continue;
          if (v !== prev) {
            anchor = row;
            prev = v;
          }
        }
        return anchor;
      };
      const summary = results.map((r) => ({
        name: r?.name,
        columns: r?.columns,
        count: r?.data?.length ?? 0,
        last: r?.data?.[r?.data?.length - 1],
        lastReal: lastReal(r?.data),
      }));
      return jsonResponse({ status: res.status, results: summary }, 200, headers);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const hit = await cache.match(cacheKey);
    if (hit) return withHeaders(hit, headers);

    try {
      const points =
        region === "NEM"
          ? sumByTimestamp(await Promise.all(REGIONS.map((r) => oeFetch(env, spec, r, from, to))))
          : await oeFetch(env, spec, region, from, to);
      const fresh = jsonResponse(
        { region, metric: spec.metric, interval: spec.interval, unit: spec.unit, points },
        200,
        { "cache-control": `max-age=${spec.ttl}` },
      );
      ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
      return withHeaders(fresh, headers);
    } catch {
      // Upstream failure: serve last-known cached data if we have any, flagged stale.
      const stale = await cache.match(cacheKey);
      if (stale) {
        const out = withHeaders(stale, headers);
        out.headers.set("X-Stale", "true");
        return out;
      }
      // Never echo the OE key or upstream URL in errors.
      return jsonResponse({ error: "upstream unavailable" }, 502, headers);
    }
  },
};
