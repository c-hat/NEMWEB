# Workstreams

Workstreams keep future changes compartmentalised. Each workstream should read
only the context it needs and avoid touching unrelated boundaries.

## 1. Frontend Views

Purpose: render charts, controls, CSV downloads, and analysis views.

Primary reads:

- `app/`
- `components/`
- `lib/data.ts`
- `lib/live.ts`
- `docs/DATA_CONTRACTS.md`

Primary writes:

- `app/`
- `components/`
- `lib/` frontend client code
- frontend tests when added

Avoid:

- editing ingest logic unless the frontend contract requires it
- reading generated `public/data` wholesale
- introducing source-specific parsing into React components

Boundary rule: frontend code consumes datasets and analyses through stable
client functions or the future Worker API, not through source adapters.

## 2. Ingest And Source Adapters

Purpose: fetch, parse, and normalize data from external sources.

Primary reads:

- `ingest/`
- `scripts/`
- `tests/fixtures/`
- `docs/DATA_CONTRACTS.md`

Primary writes:

- `ingest/`
- `scripts/`
- ingest tests and fixtures
- future source adapter modules

Avoid:

- changing React view logic
- encoding visualisation-specific shapes as the only output
- broad edits to generated `public/data`

Boundary rule: adapters are source-specific; normalized dataset contracts are
not.

## 3. Storage And Catalog

Purpose: define and maintain R2/D1 storage layout, catalogs, source runs,
dataset availability, and analysis indexes.

Primary reads:

- `docs/ARCHITECTURE.md`
- `docs/DATA_CONTRACTS.md`
- future Worker/D1 migration files
- current ingest output contracts

Primary writes:

- future database migrations
- future storage/catalog modules
- architecture docs

Avoid:

- changing chart behavior as part of storage plumbing
- exposing R2 object names directly to frontend views

Boundary rule: D1 indexes metadata and availability; R2 stores payload bodies.
The Worker API hides both from the browser.

## 4. Worker API

Purpose: provide the browser-facing data boundary.

Target endpoints:

- `GET /api/catalog`
- `GET /api/days`
- `GET /api/latest`
- `GET /api/day/:date`
- `GET /api/live`
- `GET /api/analyses`
- `GET /api/analyses/:id`

Primary reads:

- `worker/`
- `docs/DATA_CONTRACTS.md`
- `docs/DECISIONS/0001-cloudflare-runtime.md`

Primary writes:

- `worker/`
- Worker tests when added
- future API contract docs

Avoid:

- making the Worker depend on frontend component internals
- leaking source-specific raw data as API responses
- breaking the current cron dispatcher without a replacement plan

Boundary rule: the Worker API may read R2/D1/static compatibility data, but the
frontend should only see documented API responses.

## 5. Analysis

Purpose: compute derived results such as forecast errors, band breaches,
regional contribution, weather correlation, and price overlays.

Primary reads:

- normalized dataset contracts
- existing `ingest/rankings.py`
- `docs/DATA_CONTRACTS.md`
- relevant source adapter outputs

Primary writes:

- future analysis modules
- derived payload schemas
- tests for analysis calculations
- analysis index metadata

Avoid:

- hard-coding chart assumptions into analysis outputs
- reading raw generated JSON in bulk when normalized datasets or fixtures are
  enough

Boundary rule: analysis outputs are derived datasets with IDs, inputs,
parameters, timestamps, and versioned semantics.

## 6. CI And Deployment

Purpose: build, test, deploy, and schedule jobs.

Primary reads:

- `.github/workflows/` when present in the task context
- `package.json`
- `ingest/pyproject.toml`
- `worker/package.json`
- deployment docs

Primary writes:

- workflows
- deployment configuration
- environment documentation

Avoid:

- turning GitHub into the long-term data platform
- adding secrets to the repo
- changing runtime architecture without documenting the decision

Boundary rule: GitHub remains source control and CI. Runtime data should migrate
toward Cloudflare storage and APIs.
