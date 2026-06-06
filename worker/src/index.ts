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
  analysisKey,
  getCatalog,
  getJsonObject,
  type Catalog,
  type JsonValue,
  type StorageEnv,
} from "./storage";

export interface Env {
  GH_DISPATCH_TOKEN: string;
  NEMWEB_BUCKET?: R2Bucket;
  NEMWEB_DB?: D1Database;
  DATA_FALLBACK_BASE_URL?: string;
  LIVE_DATA_URL?: string;
  ALLOWED_ORIGIN?: string;
}

const OWNER = "c-hat";
const REPO = "NEMWEB";
const WORKFLOW = "live-data.yml";
const REF = "main";

// AEST = UTC+10 (no DST). Dispatch only during AEST 06:00-23:59 so the live view
// refreshes through the day and goes quiet (STALE) overnight. The cron fires
// every 10 min; outside the window we no-op (a free, negligible invocation).
const AEST_OFFSET_HOURS = 10;
const ACTIVE_START_AEST = 6; // inclusive; active hours are 06:00-23:59 AEST
const STATIC_DATA_BASE_URL = "https://raw.githubusercontent.com/c-hat/NEMWEB/main/public";
const LIVE_DATA_URL = "https://raw.githubusercontent.com/c-hat/NEMWEB/live-data/today-live.json";
const DEMAND_ERROR_ANALYSIS_ID = "demand-forecast-error-ranking";
const LEGACY_DEMAND_ERROR_ANALYSIS_ID = "demand-error-ranking";

function aestHour(now: Date): number {
  return (now.getUTCHours() + AEST_OFFSET_HOURS) % 24;
}

async function dispatch(token: string): Promise<Response> {
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
    body: JSON.stringify({ ref: REF }),
  });
}

function apiHeaders(env: Env, cacheControl = "no-store"): Headers {
  return new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": cacheControl,
  });
}

function jsonResponse(
  env: Env,
  body: unknown,
  init: ResponseInit & { cacheControl?: string } = {},
): Response {
  const headers = apiHeaders(env, init.cacheControl);
  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(env: Env, status: number, message: string): Response {
  return jsonResponse(env, { error: { status, message } }, { status });
}

function hasStorage(env: Env): env is Env & StorageEnv {
  return !!env.NEMWEB_BUCKET && !!env.NEMWEB_DB;
}

function fallbackBase(env: Env): string {
  return (env.DATA_FALLBACK_BASE_URL || STATIC_DATA_BASE_URL).replace(/\/$/, "");
}

async function fetchFallbackJson<T>(url: string): Promise<T | null> {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
  if (!res.ok) return null;
  return res.json<T>();
}

async function compatSources(
  env: Env,
  key: string,
  fallbackPath: string,
): Promise<{ r2Body: JsonValue | null; fallbackBody: JsonValue | null }> {
  const r2Promise = env.NEMWEB_BUCKET
    ? getJsonObject<JsonValue>(env as Env & StorageEnv, key)
    : Promise.resolve(null);
  const fallbackPromise = fetchFallbackJson<JsonValue>(`${fallbackBase(env)}${fallbackPath}`);
  const [r2Body, fallbackBody] = await Promise.all([r2Promise, fallbackPromise]);
  return { r2Body, fallbackBody };
}

function emptyCatalog(): Catalog {
  return { datasets: [], analyses: [], updatedAt: new Date().toISOString() };
}

function canonicalAnalysisId(id: string): string {
  return id === LEGACY_DEMAND_ERROR_ANALYSIS_ID ? DEMAND_ERROR_ANALYSIS_ID : id;
}

async function demandErrorFallback(env: Env): Promise<JsonValue | null> {
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

async function handleApi(req: Request, env: Env): Promise<Response> {
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
    const body = mostCompleteDay(r2Body, fallbackBody);
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
      r2Body = await getJsonObject<JsonValue>(env as Env & StorageEnv, compatLiveKey());
    }
    const fallbackBody = await fetchFallbackJson<JsonValue>(env.LIVE_DATA_URL || LIVE_DATA_URL);
    const body = freshestLive(r2Body, fallbackBody);
    return body == null
      ? errorResponse(env, 503, "Live data is unavailable")
      : jsonResponse(env, body, { cacheControl: "public, max-age=30" });
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
        env as Env & StorageEnv,
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
  // Cloudflare cron trigger (see [triggers] crons in wrangler.toml).
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = new Date();
    const h = aestHour(now);
    if (h < ACTIVE_START_AEST) {
      console.log(`pinger: ${now.toISOString()} (AEST hour ${h}) outside active window; skip`);
      return;
    }
    if (!env.GH_DISPATCH_TOKEN) {
      console.error("pinger: GH_DISPATCH_TOKEN secret is not set; cannot dispatch");
      return;
    }
    const res = await dispatch(env.GH_DISPATCH_TOKEN);
    if (res.status === 204) {
      console.log(`pinger: dispatched ${WORKFLOW} (AEST hour ${h}) -> 204`);
    } else {
      // GitHub returns 404 if the token lacks Actions:write, 401 if invalid.
      const body = await res.text().catch(() => "");
      console.error(`pinger: dispatch failed ${res.status}: ${body.slice(0, 300)}`);
    }
  },

  // Health check + compatibility API. Nothing is triggered here, so the public
  // workers.dev URL cannot be used to burn the OE request budget; dispatch
  // still happens solely on the cron schedule above.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(req, env);
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
