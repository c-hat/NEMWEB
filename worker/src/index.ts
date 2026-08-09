// Cloudflare Worker (cron) that keeps the NEMWEB `live-data` GitHub Action
// firing on a reliable ~10-minute cadence.
//
// Why this exists: GitHub's own `schedule` cron runs 1-4 hours late on this
// free/public repo (measured against the daily ingest job), so it can't drive a
// 10-min refresh. A `workflow_dispatch`, by contrast, starts within ~20s. So
// this Worker's cron trigger simply POSTs the workflow's dispatch endpoint every
// ~10 min during the AEST active window. It runs server-side (Worker -> GitHub
// API), so unlike the old data-proxy it is never hit by the browser and the
// corporate firewall is irrelevant. The live data itself is published to the
// `live-data` branch and read by the frontend over raw.githubusercontent.com.
//
// Secret (set once on the Worker, NOT in source): GH_DISPATCH_TOKEN — a
// fine-grained GitHub PAT scoped to c-hat/NEMWEB with Actions: Read and write.

import {
  dayTradingDate,
  freshestLive,
  isJsonRecord,
  mergedDayIndex,
  mostCompleteDay,
  newestLatest,
} from "./compat";
import {
  compatDayKey,
  compatIndexKey,
  compatLatestKey,
  compatLiveKey,
  compatTodayKey,
  forecasterBriefingKey,
  analysisKey,
  getCatalog,
  getJsonObject,
  systemContextKey,
  type Catalog,
  type JsonValue,
  type StorageEnv,
} from "./storage";
import { freshestProduct, productFreshness } from "./products";

type RuntimeEnv = Env & { GH_DISPATCH_TOKEN?: string };

const OWNER = "c-hat";
const REPO = "NEMWEB";
const WORKFLOW = "live-data.yml";
const DEFAULT_WORKFLOW_REF = "main";

// AEST = UTC+10 (no DST). Dispatch only during AEST 06:00-23:59 so the live view
// refreshes through the day and goes quiet (STALE) overnight. The cron fires
// every 10 min; outside the window we no-op (a free, negligible invocation).
const AEST_OFFSET_HOURS = 10;
const ACTIVE_START_AEST = 6; // inclusive; active hours are 06:00-23:59 AEST
const STATIC_DATA_BASE_URL = "https://raw.githubusercontent.com/c-hat/NEMWEB/main/public";
const LIVE_DATA_URL = "https://raw.githubusercontent.com/c-hat/NEMWEB/live-data/today-live.json";
const SYSTEM_CONTEXT_URL = "https://raw.githubusercontent.com/c-hat/NEMWEB/live-data/system-context.json";
const FORECASTER_BRIEFING_URL = "https://raw.githubusercontent.com/c-hat/NEMWEB/live-data/forecaster-briefing.json";
const DEMAND_ERROR_ANALYSIS_ID = "demand-forecast-error-ranking";
const LEGACY_DEMAND_ERROR_ANALYSIS_ID = "demand-error-ranking";

function logEvent(
  level: "info" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({ level, event, at: new Date().toISOString(), ...fields }));
}

function aestHour(now: Date): number {
  return (now.getUTCHours() + AEST_OFFSET_HOURS) % 24;
}

function aestDate(now = new Date()): string {
  return new Date(now.getTime() + AEST_OFFSET_HOURS * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function dispatch(token: string, ref = DEFAULT_WORKFLOW_REF): Promise<Response> {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "nemweb-live-pinger",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref }),
  });
}

function apiHeaders(env: RuntimeEnv, cacheControl = "no-store"): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": cacheControl,
  });
}

function jsonResponse(
  env: RuntimeEnv,
  body: unknown,
  init: ResponseInit & { cacheControl?: string } = {},
): Response {
  const headers = apiHeaders(env, init.cacheControl);
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(env: RuntimeEnv, status: number, message: string): Response {
  return jsonResponse(env, { error: { status, message } }, { status });
}

function hasStorage(env: RuntimeEnv): env is RuntimeEnv & StorageEnv {
  return !!env.NEMWEB_BUCKET && !!env.NEMWEB_DB;
}

function fallbackBase(env: RuntimeEnv): string {
  return (env.DATA_FALLBACK_BASE_URL || STATIC_DATA_BASE_URL).replace(/\/$/, "");
}

async function fetchFallbackJson<T>(url: string): Promise<T | null> {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
  if (!res.ok) return null;
  return res.json<T>();
}

async function compatSources(
  env: RuntimeEnv,
  key: string,
  fallbackPath: string,
): Promise<{ r2Body: JsonValue | null; fallbackBody: JsonValue | null }> {
  const r2Promise = env.NEMWEB_BUCKET
    ? getJsonObject<JsonValue>(env, key)
    : Promise.resolve(null);
  const fallbackPromise = fetchFallbackJson<JsonValue>(`${fallbackBase(env)}${fallbackPath}`);
  const [r2Body, fallbackBody] = await Promise.all([r2Promise, fallbackPromise]);
  return { r2Body, fallbackBody };
}

async function latestProduct(
  env: RuntimeEnv,
  key: string,
  fallbackUrl: string,
  fields: string[],
): Promise<JsonValue | null> {
  const [r2Body, fallbackBody] = await Promise.all([
    env.NEMWEB_BUCKET
      ? getJsonObject<JsonValue>(env, key)
      : Promise.resolve(null),
    fetchFallbackJson<JsonValue>(fallbackUrl),
  ]);
  return freshestProduct(r2Body, fallbackBody, fields);
}

function sameTradingDate(body: JsonValue | null, date: string): JsonValue | null {
  return dayTradingDate(body) === date ? body : null;
}

function emptyCatalog(): Catalog {
  return { datasets: [], analyses: [], updatedAt: new Date().toISOString() };
}

function canonicalAnalysisId(id: string): string {
  return id === LEGACY_DEMAND_ERROR_ANALYSIS_ID ? DEMAND_ERROR_ANALYSIS_ID : id;
}

async function demandErrorFallback(env: RuntimeEnv): Promise<JsonValue | null> {
  const compat = await fetchFallbackJson<JsonValue>(
    `${fallbackBase(env)}/data/demand-error-rankings.json`,
  );
  const params: { [key: string]: JsonValue } = compat != null && isJsonRecord(compat)
    ? {
        metric: compat.metric ?? null,
        topN: compat.topN ?? null,
      }
    : {};
  if (compat == null) return null;
  return {
    id: DEMAND_ERROR_ANALYSIS_ID,
    type: "forecast-error-ranking",
    version: "1.0.0",
    inputs: ["aemo-nemweb.demand.forecast", "aemo-nemweb.demand.actual"],
    parameters: params,
    generatedAt: new Date().toISOString(),
    data: compat,
  };
}

async function handleApi(req: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: apiHeaders(env) });
  }
  if (req.method !== "GET") {
    return errorResponse(env, 405, "Method not allowed");
  }

  if (path === "/api/days") {
    const { r2Body, fallbackBody } = await compatSources(env, compatIndexKey(), "/data/index.json");
    const body = mergedDayIndex(r2Body, fallbackBody);
    return body == null
      ? errorResponse(env, 503, "Days index is unavailable")
      : jsonResponse(env, body, { cacheControl: "public, max-age=300" });
  }

  if (path === "/api/latest") {
    const { r2Body, fallbackBody } = await compatSources(env, compatLatestKey(), "/data/latest.json");
    const body = newestLatest(r2Body, fallbackBody);
    return body == null
      ? errorResponse(env, 503, "Latest pointer is unavailable")
      : jsonResponse(env, body, { cacheControl: "public, max-age=300" });
  }

  const dayMatch = path.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/);
  if (dayMatch) {
    const date = dayMatch[1];
    const { r2Body, fallbackBody } = await compatSources(env, compatDayKey(date), `/data/${date}.json`);
    let body = mostCompleteDay(r2Body, fallbackBody);
    if (date === aestDate()) {
      const { r2Body: todayR2Body, fallbackBody: todayFallbackBody } = await compatSources(
        env,
        compatTodayKey(),
        "/data/today.json",
      );
      const todayBody = mostCompleteDay(
        sameTradingDate(todayR2Body, date),
        sameTradingDate(todayFallbackBody, date),
      );
      body = mostCompleteDay(body, todayBody);
    }
    return body == null
      ? errorResponse(env, 404, `No data for ${date}`)
      : jsonResponse(env, body, { cacheControl: "public, max-age=3600" });
  }

  if (path.startsWith("/api/day/")) {
    return errorResponse(env, 400, "Trading date must be YYYY-MM-DD");
  }

  if (path === "/api/live") {
    let r2Body: JsonValue | null = null;
    if (env.NEMWEB_BUCKET) {
      r2Body = await getJsonObject<JsonValue>(env, compatLiveKey());
    }
    const fallbackBody = await fetchFallbackJson<JsonValue>(env.LIVE_DATA_URL || LIVE_DATA_URL);
    const body = freshestLive(r2Body, fallbackBody);
    return body == null
      ? errorResponse(env, 503, "Live data is unavailable")
      : jsonResponse(env, body, { cacheControl: "public, max-age=30" });
  }

  if (path === "/api/system-context") {
    const body = await latestProduct(env, systemContextKey(), SYSTEM_CONTEXT_URL, ["updatedAt"]);
    return body == null
      ? errorResponse(env, 503, "System context is unavailable")
      : jsonResponse(env, body, { cacheControl: "public, max-age=30" });
  }

  if (path === "/api/briefing") {
    const body = await latestProduct(
      env,
      forecasterBriefingKey(),
      FORECASTER_BRIEFING_URL,
      ["generatedAt", "updatedAt"],
    );
    return body == null
      ? errorResponse(env, 503, "Forecaster briefing is unavailable")
      : jsonResponse(env, body, { cacheControl: "public, max-age=30" });
  }

  if (path === "/api/events") {
    const body = await latestProduct(
      env,
      forecasterBriefingKey(),
      FORECASTER_BRIEFING_URL,
      ["generatedAt", "updatedAt"],
    );
    const events = isJsonRecord(body) && Array.isArray(body.events) ? body.events : null;
    return events == null
      ? errorResponse(env, 503, "Events are unavailable")
      : jsonResponse(env, events, { cacheControl: "public, max-age=30" });
  }

  if (path === "/api/status") {
    const [live, context, briefing, latest] = await Promise.all([
      latestProduct(env, compatLiveKey(), env.LIVE_DATA_URL || LIVE_DATA_URL, ["updatedAt"]),
      latestProduct(env, systemContextKey(), SYSTEM_CONTEXT_URL, ["updatedAt"]),
      latestProduct(env, forecasterBriefingKey(), FORECASTER_BRIEFING_URL, ["generatedAt"]),
      compatSources(env, compatLatestKey(), "/data/latest.json").then(({ r2Body, fallbackBody }) =>
        newestLatest(r2Body, fallbackBody),
      ),
    ]);
    const latestDate = isJsonRecord(latest) && typeof latest.date === "string" ? latest.date : null;
    const products = {
      live: productFreshness(live, ["updatedAt"], 25),
      systemContext: productFreshness(context, ["updatedAt"], 25),
      briefing: productFreshness(briefing, ["generatedAt"], 25),
      historical: { available: latestDate != null, latestDate },
    };
    const operational = !products.live.stale && !products.systemContext.stale && !products.briefing.stale;
    return jsonResponse(env, {
      service: "nemweb-api",
      status: operational ? "operational" : "degraded",
      version: env.CF_VERSION_METADATA?.id ?? null,
      checkedAt: new Date().toISOString(),
      products,
    });
  }

  if (path === "/api/catalog") {
    const catalog = hasStorage(env) ? await getCatalog(env) : emptyCatalog();
    return jsonResponse(env, catalog, { cacheControl: "public, max-age=300" });
  }

  if (path === "/api/analyses") {
    const catalog = hasStorage(env) ? await getCatalog(env) : emptyCatalog();
    return jsonResponse(env, catalog.analyses, { cacheControl: "public, max-age=300" });
  }

  const analysisMatch = path.match(/^\/api\/analyses\/([a-z0-9][a-z0-9-]*)$/);
  if (analysisMatch) {
    const id = canonicalAnalysisId(analysisMatch[1]);
    const catalog = hasStorage(env) ? await getCatalog(env) : emptyCatalog();
    const descriptor = catalog.analyses.find((analysis) => analysis.id === id);
    let body: JsonValue | null = null;
    if (env.NEMWEB_BUCKET && descriptor) {
      body = await getJsonObject<JsonValue>(
        env,
        analysisKey(id, descriptor.version),
      );
    }
    if (body == null && id === DEMAND_ERROR_ANALYSIS_ID) {
      body = await demandErrorFallback(env);
    }
    return body == null
      ? errorResponse(env, 404, "Analysis payload is unavailable")
      : jsonResponse(env, body, { cacheControl: "public, max-age=300" });
  }

  return errorResponse(env, 404, "Not found");
}

export default {
  // Cloudflare cron trigger (see triggers.crons in wrangler.jsonc).
  async scheduled(_event: ScheduledController, env: RuntimeEnv, _ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    const h = aestHour(now);
    if (h < ACTIVE_START_AEST) {
      logEvent("info", "dispatch.skipped", { reason: "outside-active-window", aestHour: h });
      return;
    }
    if (!env.GH_DISPATCH_TOKEN) {
      logEvent("error", "dispatch.failed", { reason: "secret-not-configured" });
      return;
    }
    const ref = env.WORKFLOW_REF || DEFAULT_WORKFLOW_REF;
    let res: Response;
    try {
      res = await dispatch(env.GH_DISPATCH_TOKEN, ref);
    } catch (error) {
      logEvent("error", "dispatch.failed", {
        workflow: WORKFLOW,
        ref,
        reason: "network-error",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (res.status === 204) {
      logEvent("info", "dispatch.succeeded", { workflow: WORKFLOW, ref, aestHour: h });
    } else {
      // GitHub returns 404 if the token lacks Actions:write, 401 if invalid.
      const body = await res.text().catch(() => "");
      logEvent("error", "dispatch.failed", {
        workflow: WORKFLOW,
        ref,
        status: res.status,
        response: body.slice(0, 300),
      });
    }
  },

  // Health check + compatibility API. Nothing is triggered here, so the public
  // workers.dev URL cannot be used to burn the OE request budget; dispatch
  // still happens solely on the cron schedule above.
  async fetch(req: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env);
      } catch (error) {
        logEvent("error", "api.request.failed", {
          method: req.method,
          path: url.pathname,
          version: env.CF_VERSION_METADATA?.id ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResponse(env, 500, "Internal service error");
      }
    }
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: apiHeaders(env) });
    }
    if (req.method !== "GET") {
      return errorResponse(env, 405, "Method not allowed");
    }
    return new Response(
      "nemweb-live-pinger: cron dispatcher and compatibility API. OK\n",
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
        },
      },
    );
  },
};
