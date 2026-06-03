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

export interface Env {
  GH_DISPATCH_TOKEN: string;
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

  // Health check only. No data is served and nothing is triggered here (so the
  // public workers.dev URL can't be used to burn the OE request budget); the
  // dispatch happens solely on the cron schedule above.
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response(
      "nemweb-live-pinger: cron dispatcher for the live-data workflow. OK\n",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  },
};
