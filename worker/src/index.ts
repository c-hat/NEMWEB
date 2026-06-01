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
 * NOTE: the /demand request shape was verified against live OE. The /rooftop
 * shape follows OE's documented v4 `/data/network` power + fueltech convention
 * but could not be verified from the build environment. Confirm with a live
 * curl (use `?debug=raw` to inspect the upstream body) and, if it differs,
 * adjust ONLY that metric's `url`/`parse` in SPECS below.
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
  // 30-minute rooftop PV. Power grouped by fueltech; pick the solar_rooftop
  // series. OE's data endpoint has no 30m interval (only 5m/1h/...), so we
  // request 5m and downsample to the :00/:30 marks — which coincide with the
  // native AEMO ASEFS2 30-minute readings (OE's 5m rooftop is gap-filled
  // between them), giving the underlying cadence rather than interpolated values.
  rooftop: {
    metric: "rooftop",
    interval: "30m",
    unit: "MW",
    ttl: 1500,
    url: (region, from, to) =>
      `${OE_BASE}/v4/data/network/NEM?metrics=power&interval=5m` +
      `&primary_grouping=network_region&secondary_grouping=fueltech` +
      `&network_region=${region}&${rangeParams(from, to)}`,
    parse: (body) => {
      const results: any[] = body?.data?.[0]?.results ?? [];
      const pick =
        results.find((r) =>
          /rooftop/i.test(String(r?.columns?.fueltech ?? r?.columns?.fueltech_id ?? r?.name ?? "")),
        ) ?? results[0];
      const onHalfHour = (ts: string) => {
        const m = ts.match(/T\d{2}:(\d{2})/);
        return !m || m[1] === "00" || m[1] === "30";
      };
      return rowsToPoints(pick?.data ?? []).filter((p) => onHalfHour(p.ts));
    },
  },
};

async function oeFetch(env: Env, spec: MetricSpec, region: string, from: string, to: string): Promise<Point[]> {
  const res = await fetch(spec.url(region, from, to), {
    headers: { authorization: `Bearer ${env.OE_API_KEY}` },
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

    // Diagnostic: dump the raw upstream body (single region) to confirm shape.
    // No API key is included (it travels as a header). Truncated.
    if (url.searchParams.get("debug") === "raw" && region !== "NEM") {
      const res = await fetch(spec.url(region, from, to), {
        headers: { authorization: `Bearer ${env.OE_API_KEY}` },
      });
      return jsonResponse({ status: res.status, sample: (await res.text()).slice(0, 1200) }, 200, headers);
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
