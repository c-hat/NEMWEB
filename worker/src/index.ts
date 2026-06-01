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
 * Endpoint (this phase): GET /demand?region={NSW1|...|NEM}&from={ISO}&to={ISO}
 *   → 5-minute operational demand for the range.
 *   For NEM we fan out to the five regions and sum server-side, so the
 *   aggregate costs a single shared cache entry, not five.
 *
 * NOTE: the exact OE request/response shape below could not be verified from
 * the build environment (docs were unreachable). It reflects the documented
 * v4 `/data/network` time-series convention. Confirm with the first live curl
 * and, if the path differs, adjust ONLY `oeDemandUrl` and `parsePoints`.
 */

export interface Env {
  OE_API_KEY: string;
}

const OE_BASE = "https://api.openelectricity.org.au";
const REGIONS = ["NSW1", "VIC1", "QLD1", "SA1", "TAS1"];
const DEMAND_TTL = 240; // seconds — just under the 5-min poll, so each cycle is at most one OE call

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

// OE requires timezone-naive timestamps in network (AEST) time. Our inputs are
// already AEST (+10:00), so strip the trailing offset (or a Z) and pass the
// wall-clock part through unchanged.
function toNetworkNaive(iso: string): string {
  return iso.replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
}

function oeDemandUrl(region: string, from: string, to: string): string {
  return (
    `${OE_BASE}/v4/market/network/NEM?metrics=demand&interval=5m` +
    `&primary_grouping=network_region&network_region=${region}` +
    `&date_start=${encodeURIComponent(toNetworkNaive(from))}&date_end=${encodeURIComponent(toNetworkNaive(to))}`
  );
}

// OE v4 time series: { data: [ { results: [ { data: [[ts, value], ...] } ] } ] }.
function parsePoints(body: any): Point[] {
  const rows: [string, number | null][] = body?.data?.[0]?.results?.[0]?.data ?? [];
  return rows.map(([ts, value]) => ({ ts, value: value ?? null }));
}

async function oeDemand(env: Env, region: string, from: string, to: string): Promise<Point[]> {
  const res = await fetch(oeDemandUrl(region, from, to), {
    headers: { authorization: `Bearer ${env.OE_API_KEY}` },
  });
  if (res.status === 401 || res.status === 403) throw new Error("oe-auth");
  if (!res.ok) throw new Error("oe-upstream");
  return parsePoints(await res.json());
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
    if (url.pathname !== "/demand") return jsonResponse({ error: "not found" }, 404, headers);

    const region = url.searchParams.get("region") ?? "";
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if ((region !== "NEM" && !REGIONS.includes(region)) || !from || !to) {
      return jsonResponse({ error: "region, from and to are required" }, 400, headers);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const hit = await cache.match(cacheKey);
    if (hit) return withHeaders(hit, headers);

    try {
      const points =
        region === "NEM"
          ? sumByTimestamp(await Promise.all(REGIONS.map((r) => oeDemand(env, r, from, to))))
          : await oeDemand(env, region, from, to);
      const fresh = jsonResponse({ region, metric: "demand", interval: "5m", unit: "MW", points }, 200, {
        "cache-control": `max-age=${DEMAND_TTL}`,
      });
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
