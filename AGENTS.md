# NEMWEB Agent Context

This repo is a static NEM forecast tracker plus ingestion tooling. The near-term
goal is to keep the current app stable while adding architecture scaffolding for
an incremental move toward Cloudflare Pages, Worker APIs, R2, and D1.

## Start Here

Read these files before broad changes:

1. `docs/CONTEXT_INDEX.md` - repo map and which files to read for each task.
2. `docs/ARCHITECTURE.md` - current and target architecture.
3. `docs/WORKSTREAMS.md` - ownership boundaries and allowed edits.
4. `docs/DATA_CONTRACTS.md` - current JSON shapes and target API contracts.
5. `docs/DECISIONS/0001-cloudflare-runtime.md` - Cloudflare runtime direction.

## Hard Context Rule

Do not read `public/data/*.json` or `public/data/**` wholesale unless the task is
specifically about generated data content. These files are generated payloads and
can waste context quickly. Prefer:

- `docs/DATA_CONTRACTS.md`
- `lib/data.ts`
- `ingest/README.md`
- targeted reads of one small sample file only when schema confirmation is
  required

## Strategic Direction

- GitHub remains git and CI, not the long-term runtime/data platform.
- Production runtime/data should move incrementally toward:
  - Cloudflare Pages for the static frontend
  - Cloudflare Worker API as the browser data boundary
  - R2 for raw, normalized, generated, and derived payload objects
  - D1 for catalog metadata, source runs, dataset availability, and analysis
    indexes
- Preserve the current working app during migration.
- Avoid whole-app rewrites. Add seams and contracts first.

## Core Principle

Data source does not equal dataset does not equal analysis does not equal
visualisation.

Keep source adapters, normalized datasets, analysis outputs, and frontend views
separate in naming, contracts, and code ownership.

## Current Repo Map

- `app/` - Next.js app shell and page composition.
- `components/` - React chart/UI components.
- `lib/` - frontend data clients, live-data client, CSV helpers.
- `ingest/` - Python NEMWEB ingest and ranking generation.
- `scripts/` - helper scripts, including live-data fetching.
- `worker/` - current Cloudflare Worker cron dispatcher for GitHub Actions.
- `.github/workflows/` - CI, Pages deploy, ingest, live-data, and Worker deploy
  workflows.
- `tests/` - Python tests and fixtures.
- `public/data/` - generated frontend JSON payloads. Avoid broad reads.
- `docs/` - architecture and AI context scaffolding.

## Migration Posture

When implementing future work:

- Prefer adding documented contracts before changing behavior.
- Keep current static `public/data` reads working until a Worker API replacement
  is ready and tested.
- Treat the future Worker API as the frontend data boundary.
- Treat R2/D1 as storage/catalog implementation details behind that API.
- Do not couple visualisations directly to source-specific raw data.
