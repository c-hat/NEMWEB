# Architecture

NEMWEB currently visualises AEMO half-hourly operational demand and rooftop PV
forecasts against actuals. The app works today as a static Next.js export backed
by generated JSON files. The target architecture keeps that frontend stable
while moving runtime data behind Cloudflare.

## Current Architecture

```text
AEMO/NEMWEB reports
        |
        v
Python ingest (`ingest/`)
        |
        v
generated JSON committed to `public/data/`
        |
        v
static Next.js export (`out/`)
        |
        v
browser fetches `/data/*.json`
```

Current live overlay:

```text
Cloudflare Worker cron
        |
        v
GitHub Actions workflow_dispatch
        |
        v
`scripts/fetch_live.py`
        |
        v
force-pushed `live-data` branch
        |
        v
browser fetches raw.githubusercontent.com today-live.json
```

Important current facts:

- The frontend is a static Next.js export configured by `next.config.js`.
- Runtime historical data is read from `public/data`.
- `lib/data.ts` owns current frontend JSON fetches and TypeScript contracts.
- `lib/live.ts` owns the current live JSON fetch from `raw.githubusercontent.com`.
- `ingest/` owns generated historical JSON payloads.
- `worker/` is currently a cron dispatcher. It is not yet the browser data API.
- The ingest workflow currently commits generated JSON back into the repo.
- `.github/workflows/` contains the current CI, Pages deploy, ingest, live-data,
  and Worker deploy automation.

## Target Architecture

```text
source adapters
  |-- AEMO/NEMWEB CSV/ZIP
  |-- OpenElectricity API
  |-- weather APIs
  |-- market/dispatch feeds
  |-- static reference data
        |
        v
storage layers
  |-- raw objects in R2
  |-- normalized dataset objects in R2
  |-- derived analysis payloads in R2
  |-- catalog, runs, availability, and indexes in D1
        |
        v
Cloudflare Worker API
        |
        v
static frontend on Cloudflare Pages
        |
        v
feature/view definitions render analyses and charts
```

Target runtime responsibilities:

- Cloudflare Pages serves the static frontend.
- Worker API is the only browser-facing data boundary.
- R2 stores large objects and payloads.
- D1 stores queryable metadata and indexes.
- GitHub Actions can still run CI and scheduled jobs during transition, but
  generated production data should move out of git over time.

## Separation Model

Use four separate concepts:

- Source: where data came from and how it was fetched or parsed.
- Dataset: normalized time-series or reference data with stable semantics.
- Analysis: derived result computed from one or more datasets.
- Visualisation: frontend view definition that renders data or analysis output.

Examples:

- Source: AEMO `Operational_Demand/FORECAST_HH` CSV report.
- Dataset: regional half-hour operational demand forecast bands.
- Analysis: daily demand forecast error ranking.
- Visualisation: forecast vs actual chart for a selected date and region.

## Incremental Migration Path

1. Document and preserve current contracts.
2. Introduce catalog and API contract definitions without changing frontend
   behavior.
3. Add Worker API endpoints that can serve the current JSON shape from existing
   static files or R2-backed objects.
4. Move generated payload writes from `public/data` to R2 while maintaining API
   compatibility.
5. Add D1 catalog tables for days, datasets, source runs, and analyses.
6. Refactor frontend data loading to use Worker API endpoints.
7. Move visualisations toward feature/view definitions after data access is
   behind the Worker boundary.

## Non-Goals For Now

- Do not rewrite the whole frontend.
- Do not remove `public/data` until the Worker API replacement is live.
- Do not make stabilisation-only changes unless required by the active task.
- Do not couple new analyses directly to raw source formats.
