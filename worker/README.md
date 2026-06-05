# nemweb-live-pinger (Cloudflare Worker)

A Cloudflare Worker that currently does two jobs:

- keeps the NEMWEB **`live-data`** GitHub Action firing on a reliable
  ~10-minute cadence
- serves the migration compatibility API under `/api/*`

**Why it exists**

GitHub's own `schedule` cron runs **1–4 hours late** on this free/public repo
(measured against the daily `ingest` job), so it can't drive a 10-minute
refresh. A `workflow_dispatch`, by contrast, starts within **~20 s**. So every
~10 min this Worker POSTs the workflow's dispatch endpoint. It runs server-side
(Worker → GitHub API), so — unlike the old data-proxy this replaced — it is
never hit by the browser and a corporate firewall is irrelevant.

The live data itself is still produced by the workflow (`scripts/fetch_live.py`)
and force-pushed to the `live-data` branch. During migration, `/api/live` hides
that fallback location from the browser and will read R2 `compat/live.json` once
storage is provisioned.

## How it works

- Cron trigger `*/10 * * * *` (UTC) — see `[triggers]` in `wrangler.toml`.
- The handler gates to the **AEST active window (06:00–23:59)**; outside it the
  invocation no-ops (free), so the live view goes STALE overnight by design.
- On each active tick it `POST`s
  `https://api.github.com/repos/c-hat/NEMWEB/actions/workflows/live-data.yml/dispatches`
  with body `{"ref":"main"}`, authenticated by the `GH_DISPATCH_TOKEN` secret.
- A success is HTTP `204`. `401` means the token is invalid; `404` usually means
  it lacks the `Actions: write` permission. Failures are logged (`wrangler tail`).
- The `fetch` handler serves a health check at `/` and compatibility JSON under
  `/api/*`. It triggers nothing, so the public `workers.dev` URL can't be used
  to burn the OE budget.

Budget: ~6 dispatches/hour × ~18 active hours ≈ 108 demand + ~36 rooftop OE
requests/day, well under OE's 500/day free-tier cap.

## Compatibility API

Endpoints:

- `GET /api/days`
- `GET /api/latest`
- `GET /api/day/:date`
- `GET /api/live`
- `GET /api/catalog`
- `GET /api/analyses`
- `GET /api/analyses/:id`

Current behavior:

- If R2/D1 bindings are present, compatibility payloads are read from R2
  `compat/*`, and catalog responses come from D1 via `src/storage.ts`.
- Until bindings are provisioned, `/api/days`, `/api/latest`, `/api/day/:date`,
  and `/api/live` fall back to the current GitHub-hosted compatibility files.
- `/api/catalog` and `/api/analyses` return empty compatible responses without
  D1. `/api/analyses/:id` returns a JSON 404 until analysis storage exists.

Optional variables:

- `DATA_FALLBACK_BASE_URL`: base URL for static compatibility files. Defaults to
  `https://raw.githubusercontent.com/c-hat/NEMWEB/main/public`.
- `LIVE_DATA_URL`: fallback live JSON URL. Defaults to the `live-data` branch.
- `ALLOWED_ORIGIN`: CORS allow-origin value. Defaults to `*`.

## Setup

Prerequisites: a Cloudflare account and a **fine-grained GitHub PAT** scoped to
`c-hat/NEMWEB` with **Actions: Read and write** (Metadata is included
automatically).

1. **Deploy the Worker.** Either let the `deploy-worker` GitHub Action do it
   (it runs on push to `worker/**`, using the `CLOUDFLARE_API_TOKEN` repo
   secret), or deploy locally. If `NEMWEB_D1_DATABASE_NAME` is configured as a
   repository variable, CI applies D1 migrations before deploy.

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

API smoke checks:

```bash
curl https://<worker-host>/api/days
curl https://<worker-host>/api/latest
curl https://<worker-host>/api/catalog
```

## Local dev

```bash
npm run dev                 # wrangler dev
# In another shell, trigger the cron handler on demand:
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

For a real dispatch in dev you need `GH_DISPATCH_TOKEN` in `worker/.dev.vars`
(gitignored): `GH_DISPATCH_TOKEN=your_pat_here`.
