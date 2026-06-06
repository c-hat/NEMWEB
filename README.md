# NEMWEB

NEMWEB visualises AEMO half-hourly operational demand and rooftop PV forecasts
against actuals. The frontend is a static Next.js export, but the target runtime
is Cloudflare: Pages serves the app, a Worker provides the browser data API, R2
stores payloads, and D1 stores catalog/availability metadata.

GitHub remains source control and CI. It is not the long-term runtime data
platform.

## Architecture

Target runtime flow:

```text
AEMO / NEMWEB / live sources
        |
        v
source adapters and ingest jobs
        |
        v
R2 payload objects + D1 catalog metadata
        |
        v
Cloudflare Worker API
        |
        v
Cloudflare Pages static frontend
```

The important boundary is the Worker API. The browser should consume documented
API responses, not R2 object names, D1 rows, GitHub raw files, or source-specific
CSV shapes.

The current migration keeps compatibility JSON shapes working while the storage
path is being proven:

- `compat/day/<date>.json`, `compat/index.json`, `compat/latest.json`, and
  `compat/live.json` live in R2.
- D1 tracks source runs, datasets, day availability, analyses, and data quality.
- The Worker exposes `/api/*` endpoints that mirror the existing frontend data
  contracts where needed.
- `public/data/` remains a compatibility output during transition, not the
  target production data platform.

See:

- `docs/ARCHITECTURE.md`
- `docs/DATA_CONTRACTS.md`
- `docs/DECISIONS/0001-cloudflare-runtime.md`
- `docs/DECISIONS/0002-storage-layout.md`
- `docs/CLOUDFLARE_SETUP.md`

## Repo Map

- `app/` - Next.js app shell and page composition.
- `components/` - chart and UI components.
- `lib/` - frontend data clients, API/static switching, live-data client, CSV helpers.
- `ingest/` - Python NEMWEB ingest and normalized day construction.
- `scripts/` - operational helpers, including Cloudflare publish and live fetch.
- `worker/` - Cloudflare Worker cron dispatcher and compatibility API.
- `tests/` - Python ingest, live-data, analysis, and publish tests.
- `public/data/` - generated compatibility payloads. Do not treat as hand-authored source.
- `docs/` - architecture, contracts, decisions, and migration plans.

## Data Model

Keep these concepts separate:

- Source: where data came from and how it was fetched or parsed.
- Dataset: normalized time-series or reference data with stable semantics.
- Analysis: derived output computed from one or more datasets.
- Visualisation: frontend view that renders datasets or analysis payloads.

Current normalized dataset families include:

- `aemo-nemweb.demand.forecast`
- `aemo-nemweb.demand.actual`
- `aemo-nemweb.rooftopPv.forecast`
- `aemo-nemweb.rooftopPv.actual`

The day-ahead forecast cutoff is currently the latest run stamped at or before
`D-1 17:00 AEST`. Do not change that semantic without updating
`docs/DATA_CONTRACTS.md` and ingest tests in the same change.

## Frontend

The app is a static Next.js export:

```sh
npm install
npm run dev
npm run build
```

Build output goes to `out/`.

Data loading is controlled at build time:

```sh
# Transitional/static mode: reads /data/*.json from the static export.
NEXT_PUBLIC_DATA_SOURCE=static npm run build

# Cloudflare/API mode: reads the Worker API.
NEXT_PUBLIC_DATA_SOURCE=api \
NEXT_PUBLIC_API_BASE_URL=https://nemweb-live-pinger.nemwebber.workers.dev \
npm run build
```

The frontend imports from `lib/dataClient.ts`, which selects either the static
compatibility files or the Worker API. New frontend code should use that client
boundary rather than fetching storage paths directly.

## Worker API

The Worker exposes:

- `GET /api/catalog`
- `GET /api/days`
- `GET /api/latest`
- `GET /api/day/:date`
- `GET /api/live`
- `GET /api/analyses`
- `GET /api/analyses/:id`

Run locally:

```sh
cd worker
npm install
npm run typecheck
npm run dev
```

Deployments use Wrangler and the bindings in `worker/wrangler.toml`.

## Storage And Publish

Generated compatibility payloads are published to Cloudflare with:

```sh
python3 scripts/publish_cloudflare.py \
  --bucket nemweb-data-prod \
  --database nemweb-catalog-prod
```

Live data can be published independently:

```sh
python3 scripts/publish_cloudflare.py \
  --only-live \
  --live today-live.json \
  --bucket nemweb-data-prod
```

The publisher uploads R2 compatibility objects and updates D1 catalog rows. It
publishes pointer objects last so clients do not see an index/latest entry before
the referenced payload exists.

## Deployment

The desired deployed shape is:

- Cloudflare Pages for the static frontend.
- Cloudflare Worker for the browser API and scheduled live refresh dispatch.
- R2 for raw, normalized, compatibility, live, and analysis payloads.
- D1 for catalog, source runs, dataset availability, and analysis availability.

Cloudflare Pages builds should use API mode:

```sh
NEXT_PUBLIC_DATA_SOURCE=api
NEXT_PUBLIC_API_BASE_URL=<worker-url>
```

Branch previews should be deployed from the branch being validated, with the
same API-mode environment, before cutting the architecture branch across to
`main`.

The legacy GitHub Pages/static-data path may remain during migration as a
rollback route, but it should not be expanded as the production architecture.

## Verification

Useful checks:

```sh
npm run test
env NEXT_PUBLIC_DATA_SOURCE=api \
  NEXT_PUBLIC_API_BASE_URL=https://nemweb-live-pinger.nemwebber.workers.dev \
  npm run build

cd ingest
uv run python -m pytest -q

cd ../worker
npm run typecheck
npm run test
```

Operational smoke checks:

```sh
curl https://<worker-url>/api/latest
curl https://<worker-url>/api/day/YYYY-MM-DD
curl https://<worker-url>/api/live
curl https://<worker-url>/api/catalog
```

## Migration Rule

Do not couple visualisations to source-specific raw data or Cloudflare storage
implementation details. Add or update contracts first, keep the current app
stable, and move runtime data behind the Worker API incrementally.
