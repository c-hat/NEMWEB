# Plan: CI & Deployment

Workstream 6 in [`docs/WORKSTREAMS.md`](../WORKSTREAMS.md). Owns workflows,
deployment config, and environment docs. GitHub stays source control + CI;
runtime/data migrate to Cloudflare.

## Current state (verified)

Five workflows in `.github/workflows/`:

- `test.yml` — Python ingest tests via `uv` on every push/PR. **No JS/Worker
  tests run.**
- `ingest.yml` — daily 03:00 AEST (`cron: 0 17 * * *`) + dispatch; fetches live
  NEMWEB, runs `ingest.py … --today`, commits JSON to `public/data` on the
  branch.
- `live-data.yml` — `workflow_dispatch` only; runs `scripts/fetch_live.py`
  (demand from OE via `OE_API_KEY`, rooftop/forecasts from NEMWEB) and
  force-pushes a single-file orphan commit to the `live-data` branch.
- `deploy-pages.yml` — builds the static export and deploys to **GitHub Pages**
  on push to `main` and after `ingest` completes; sets
  `NEXT_PUBLIC_BASE_PATH=/<repo>`.
- `deploy-worker.yml` — `wrangler deploy` of the pinger on `worker/**` pushes;
  needs `CLOUDFLARE_API_TOKEN`.

Deployment today: **GitHub Pages**, not Cloudflare Pages. Data lives in git and
a force-pushed branch.

## Finalisation target

- Frontend deploys to **Cloudflare Pages** (Pages serves static, Worker API
  serves data).
- R2 buckets + D1 database provisioned and bound; migrations run in CI.
- Scheduled jobs continue on GitHub Actions during transition, but generated
  production data moves **out of git** into R2 over time.
- CI runs the full test matrix: Python (ingest/analysis), JS (frontend), Worker.

## Dependencies

- **Storage (03)** defines the R2/D1 resources to provision and migrate.
- **Worker API (04)** + **Frontend (01)** define the Pages/Worker deploy targets.
- Sequenced last per stream: each CI change tracks the stream it supports.

## Tasks (ordered)

### Phase A — test coverage parity

1. **Add a JS test job** to `test.yml` (Vitest from workstream 1) so frontend
   tests gate PRs.
2. **Add a Worker test job** (Vitest workers pool from workstream 4) plus a
   `wrangler deploy --dry-run`/typecheck so the Worker is validated in CI.

### Phase B — provision Cloudflare storage

3. **Provision R2 + D1** via `wrangler` (bindings declared in
   `worker/wrangler.toml`, created with documented commands). Add a CI step that
   applies D1 **migrations** (`wrangler d1 migrations apply`) on deploy.
4. **Seed migration in CI** — run the workstream-3 seed that uploads current
   `public/data` to R2 `compat/*` and populates D1, gated behind manual dispatch
   first.

### Phase C — cut deployment over to Cloudflare

5. **Add a Cloudflare Pages deploy** (`wrangler pages deploy out`) alongside the
   existing GitHub Pages deploy. Run **both in parallel** initially; verify Pages
   serves identically.
6. **Point the frontend at the Worker API** via build env
   (`NEXT_PUBLIC_DATA_SOURCE=api`, `NEXT_PUBLIC_WORKER_URL`) once the API is
   proven. Keep GitHub Pages as a fallback until a release runs clean on
   Cloudflare.
7. **Retire git-as-data-platform.** Change `ingest.yml` to write payloads to R2
   (via workstream 2/3) instead of committing to `public/data`; stop the
   `deploy-pages` `workflow_run` data-redeploy chain once data is API-served.
   Phase out `live-data.yml` + the orphan branch after `/api/live` is live.
8. **Decommission GitHub Pages** only after Cloudflare Pages + Worker API have
   served a production release without regression.

## Contracts to honour

- GitHub remains source control + CI; Cloudflare is runtime + data.
- No secrets in the repo: `OE_API_KEY` (Worker secret + CI secret as used),
  `CLOUDFLARE_API_TOKEN`, `GH_DISPATCH_TOKEN` (Worker secret) stay out of source.
- Document every runtime/architecture change as an ADR under `docs/DECISIONS/`.

## Acceptance criteria

- CI runs Python + JS + Worker tests on every PR.
- R2/D1 provisioned, bound, and migrated from CI; seed reproduces current data.
- Cloudflare Pages serves the frontend identically to GitHub Pages; Worker API
  is reachable from the Pages origin (CORS verified).
- A documented rollback exists at each cutover (Pages, data source, live path).

## Guardrails

- Do not turn GitHub into the long-term data platform.
- Do not add secrets to the repo.
- Do not change runtime architecture without an ADR.
- Run old and new deploy paths in parallel before removing the old one.
