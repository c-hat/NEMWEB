# nemweb-live-pinger (Cloudflare Worker)

A cron-only Cloudflare Worker that keeps the NEMWEB **`live-data`** GitHub
Action firing on a reliable ~10-minute cadence.

**Why it exists**

GitHub's own `schedule` cron runs **1–4 hours late** on this free/public repo
(measured against the daily `ingest` job), so it can't drive a 10-minute
refresh. A `workflow_dispatch`, by contrast, starts within **~20 s**. So every
~10 min this Worker POSTs the workflow's dispatch endpoint. It runs server-side
(Worker → GitHub API), so — unlike the old data-proxy this replaced — it is
never hit by the browser and a corporate firewall is irrelevant.

The live data itself is produced by the workflow (`scripts/fetch_live.py`) and
force-pushed to the `live-data` branch, which the frontend reads over
`raw.githubusercontent.com`. This Worker only pulls the trigger.

## How it works

- Cron trigger `*/10 * * * *` (UTC) — see `[triggers]` in `wrangler.toml`.
- The handler gates to the **AEST active window (06:00–23:59)**; outside it the
  invocation no-ops (free), so the live view goes STALE overnight by design.
- On each active tick it `POST`s
  `https://api.github.com/repos/c-hat/NEMWEB/actions/workflows/live-data.yml/dispatches`
  with body `{"ref":"main"}`, authenticated by the `GH_DISPATCH_TOKEN` secret.
- A success is HTTP `204`. `401` means the token is invalid; `404` usually means
  it lacks the `Actions: write` permission. Failures are logged (`wrangler tail`).
- The `fetch` handler is a health check only — it serves no data and triggers
  nothing, so the public `workers.dev` URL can't be used to burn the OE budget.

Budget: ~6 dispatches/hour × ~18 active hours ≈ 108 demand + ~36 rooftop OE
requests/day, well under OE's 500/day free-tier cap.

## Setup

Prerequisites: a Cloudflare account and a **fine-grained GitHub PAT** scoped to
`c-hat/NEMWEB` with **Actions: Read and write** (Metadata is included
automatically).

1. **Deploy the Worker.** Either let the `deploy-worker` GitHub Action do it
   (it runs on push to `worker/**`, using the `CLOUDFLARE_API_TOKEN` repo
   secret), or deploy locally:

   ```bash
   export CLOUDFLARE_API_TOKEN=your_token_here   # do not commit
   cd worker
   npm install
   npx wrangler whoami        # verifies the token
   npm run deploy
   ```

2. **Add the GitHub PAT as a Worker secret** (once; persists across deploys):

   ```bash
   npx wrangler secret put GH_DISPATCH_TOKEN     # paste the PAT when prompted
   ```

   Or in the Cloudflare dashboard: **Workers & Pages → nemweb-live-pinger →
   Settings → Variables and Secrets → Add → type Secret →
   `GH_DISPATCH_TOKEN`**.

3. **(Cleanup)** The old `nemweb-proxy` Worker is no longer used and can be
   deleted in the dashboard (**Workers & Pages → nemweb-proxy → Settings →
   Delete**). The frontend now reads `live-data` directly, not the proxy.

## Verify

```bash
npx wrangler tail            # watch live logs; expect a "dispatched … -> 204"
                            # line at the next 10-min boundary (during 06:00–23:59 AEST)
```

A successful dispatch shows up as a new `live-data` workflow run in the GitHub
Actions tab and a fresh `today-live.json` on the `live-data` branch within ~30 s.

## Local dev

```bash
npm run dev                 # wrangler dev
# In another shell, trigger the cron handler on demand:
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

For a real dispatch in dev you need `GH_DISPATCH_TOKEN` in `worker/.dev.vars`
(gitignored): `GH_DISPATCH_TOKEN=your_pat_here`.
