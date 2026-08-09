# Plan: Worker API

Workstream 4 in [`docs/WORKSTREAMS.md`](../WORKSTREAMS.md). Owns `worker/`,
Worker tests, and API contract docs. The browser-facing data boundary.

## Current state (verified)

- `worker/src/index.ts` (82 lines) is a **cron dispatcher only**: every ~10 min
  in the AEST active window it POSTs the `live-data.yml` workflow's dispatch
  endpoint. `fetch` is a health-check string — it serves no data. Secret:
  `GH_DISPATCH_TOKEN`.
- `worker/wrangler.toml`: `name = nemweb-live-pinger`, cron `*/10 * * * *`, no R2
  or D1 bindings.
- Deployed via `.github/workflows/deploy-worker.yml` on `worker/**` pushes.
- **No API routing, no R2/D1 access, no Worker tests.**
- Note: a comment in the README implies a Worker data-proxy for live data, but
  the live path actually goes through `raw.githubusercontent.com` (the
  `live-data` branch). The Worker is purely the pinger today.

## Finalisation target

The Worker becomes the **only browser-facing data boundary**, serving the seven
endpoints in [`docs/DATA_CONTRACTS.md`](../DATA_CONTRACTS.md) from R2/D1 (with a
static/compat fallback during migration). The cron dispatcher continues to run
until the live pipeline is moved behind the API.

## Dependencies

- **Storage & Catalog (03)** for R2/D1 bindings and the storage access module.
- **Analysis (05)** for `/api/analyses` payloads.
- **Frontend (01)** flips to these endpoints behind a flag once they're proven.

## Tasks (ordered)

1. **Add a router without breaking the cron.** Keep `scheduled` (the pinger)
   exactly as-is. Add HTTP routing in `fetch` (a tiny router or Hono). Health
   check stays at `/`.
2. **Implement compatibility endpoints first** (serve current shapes, so the
   frontend can switch with zero visual change):
   - `GET /api/days` → `[{ "date": "..." }]` (current `index.json`)
   - `GET /api/latest` → `{ "date", "path" }`
   - `GET /api/day/:date` → current per-day payload
   - `GET /api/live` → current live file shape (hiding the storage location)

   Source these from R2 `compat/*` (workstream 3) with a fallback to the static
   files / `live-data` branch behind a binding flag while migrating.
3. **Add `GET /api/catalog`** → `{ datasets, analyses, updatedAt }` from D1.
4. **Add `GET /api/analyses`** (descriptors) and `GET /api/analyses/:id` (one
   payload: `id, type, version, inputs, parameters, generatedAt, data`) from the
   analysis index + R2 (workstream 5).
5. **CORS, caching, errors.** Set CORS for the Pages origin, `Cache-Control`
   appropriate per endpoint (short for `/api/live`, longer for dated `/api/day`),
   and consistent JSON error bodies with status codes.
6. **Worker tests.** Add Vitest + `@cloudflare/vitest-pool-workers` (or Miniflare)
   covering routing, each endpoint's shape, the compat fallback, and that the
   cron handler is unchanged. Wire into CI (workstream 6).
7. **Bind R2/D1** in `wrangler.toml` (from workstream 3) and read through the
   storage module — the Worker must not embed R2 keys/SQL itself.
8. **Move live data behind `/api/live`.** Once the live adapter writes to storage
   (workstream 2 Phase C), serve `/api/live` from R2 and retire the
   `raw.githubusercontent.com` path on the frontend. Decommission the
   `live-data` branch + pinger only after the API path is proven in production.

## Contracts to honour

- Endpoints and shapes per [`docs/DATA_CONTRACTS.md`](../DATA_CONTRACTS.md)
  §Target Worker API; compatibility responses must match current JSON exactly
  first, then extend additively (never remove `date`/`path`).
- The frontend only ever sees documented API responses — never R2 keys, D1
  layouts, or source-specific raw formats.

## Acceptance criteria

- All seven endpoints respond with documented shapes; compat endpoints are
  byte-compatible with current static files (validated against 2026-05-28).
- The cron dispatcher behaviour is provably unchanged (test + manual dispatch
  check).
- Worker tests run in CI; `wrangler deploy` succeeds with R2/D1 bindings.
- The frontend, switched to `api`, renders identically to the static path.

## Guardrails

- Do not break the cron dispatcher without a replacement plan.
- Do not leak source-specific raw data as API responses.
- Do not make the Worker depend on frontend component internals.
- No secrets in source; keep `GH_DISPATCH_TOKEN` and any keys as Worker secrets.
