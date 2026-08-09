# Plan: Storage & Catalog

Workstream 3 in [`docs/WORKSTREAMS.md`](../WORKSTREAMS.md). Owns R2/D1 layout,
catalog, source runs, dataset availability, and analysis indexes. Greenfield.

## Current state (verified)

- **No R2, no D1, no storage modules exist.** All payloads are JSON files in
  `public/data/` committed to git; live data is a single file force-pushed to the
  `live-data` branch.
- Catalog/availability is implicit: `index.json` (days list) and `latest.json`
  (pointer) are the only "catalog" today.
- Target layout is described in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) and
  [`docs/DATA_CONTRACTS.md`](../DATA_CONTRACTS.md) §Future Storage Metadata.

## Finalisation target

- **R2** stores payload bodies: raw source objects, normalized dataset objects,
  generated frontend-compatible payloads (during migration), derived analysis
  payloads.
- **D1** stores queryable metadata: source definitions, source runs, raw object
  refs, normalized dataset availability, derived analysis availability, data
  quality summaries, schema/contract versions.
- The **Worker API hides both** from the browser. R2 keys and D1 layouts are
  internal implementation details.

## Dependencies

- Consumes outputs from **Ingest (02)** and **Analysis (05)**.
- Is consumed by **Worker API (04)**, which is the only reader the browser sees.
- **CI/Deployment (06)** provisions the R2 buckets and D1 database and runs
  migrations.

## Tasks (ordered)

1. **Decide and document the R2 key scheme.** Propose a stable, versioned layout,
   e.g.:
   - `raw/<source>/<run-id>/<original-filename>`
   - `dataset/<dataset-id>/<date>.json` (normalized)
   - `compat/day/<date>.json`, `compat/index.json`, `compat/latest.json`,
     `compat/live.json` (migration mirrors of current `public/data`)
   - `analysis/<analysis-id>/<version>.json`

   Record it as `docs/DECISIONS/0002-storage-layout.md`. Keys are internal — not
   a public contract.
2. **Design the D1 schema.** Tables (draft):
   - `sources` (id, label, kind, config)
   - `source_runs` (id, source_id, params, started_at, finished_at, status,
     error, r2_refs)
   - `datasets` (id, label, metric, cadence, regions, units, schema_version)
   - `dataset_availability` (dataset_id, date, status, r2_key, quality)
   - `analyses` (id, type, label, inputs, parameters, version)
   - `analysis_availability` (analysis_id, date_or_range, r2_key, generated_at)
   - `data_quality` (scope, date, metric, summary)

   Write SQL migrations under `worker/migrations/` (or a `db/` dir) and document
   in `docs/DATA_CONTRACTS.md`.
3. **Build a storage access module** (TypeScript, used by the Worker; optionally a
   Python writer used by ingest). Functions: `putRaw`, `putDataset`,
   `putCompat`, `putAnalysis`, `recordRun`, `setAvailability`, `getAvailability`,
   `getCatalog`. The module is the only thing that knows R2 keys / D1 SQL.
4. **Seed the catalog from existing data.** A one-off migration that uploads the
   current `public/data` files to R2 `compat/*` and populates `datasets` /
   `dataset_availability` / the days list, so `GET /api/days`/`/latest`/`/day`
   can be served from storage with identical output.
5. **Provision via CI** (hand to workstream 6): `wrangler` R2 bucket bindings and
   D1 database, with bindings declared in `worker/wrangler.toml`. Secrets stay
   out of source.
6. **Add a catalog generator** that produces `GET /api/catalog`'s
   `datasets`/`analyses`/`updatedAt` from D1, so availability is queryable rather
   than implicit.

## Contracts to honour

- D1 indexes metadata and availability; R2 stores payload bodies.
- Do not expose R2 object keys or D1 table layouts as frontend contracts unless
  explicitly promoted to a documented stable API field.
- Missing values stay `null` inside payloads; availability rows capture
  per-date/per-dataset presence and quality.

## Acceptance criteria

- R2 buckets and a D1 database exist and are bound in `worker/wrangler.toml`.
- Migrations apply cleanly and are committed; schema documented in
  `docs/DATA_CONTRACTS.md`.
- The seed migration reproduces current days/latest/day payloads from storage
  byte-for-byte (validated against 2026-05-28).
- The storage module is the sole owner of keys/SQL; nothing else references R2
  keys directly.

## Guardrails

- Do not change chart behaviour as part of storage plumbing.
- Do not leak R2 object names to frontend views.
- Keep `public/data` working until the Worker API serves storage-backed data.
- No secrets in the repo.
