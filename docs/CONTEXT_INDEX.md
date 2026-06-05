# Context Index

Use this file to choose the smallest useful context for a task.

## Always Avoid By Default

- Do not read `public/data/*.json` or `public/data/**` wholesale.
- Do not load generated historical payloads to understand architecture.
- Do not inspect large fixture trees unless testing or parser behavior requires
  it.

Use `docs/DATA_CONTRACTS.md`, `lib/data.ts`, and `ingest/README.md` first.

## Common Task Context

### Architecture Or Planning

Read:

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/WORKSTREAMS.md`
- `docs/DATA_CONTRACTS.md`
- `docs/DECISIONS/0001-cloudflare-runtime.md`

Usually avoid:

- `public/data/`
- implementation files unless validating a claim

### Frontend View Changes

Read:

- `app/page.tsx`
- `app/layout.tsx`
- `app/globals.css`
- `components/ForecastChart.tsx`
- `lib/data.ts`
- `lib/live.ts`
- `lib/useLiveData.ts`
- `lib/csv.ts` if CSV export is involved

Usually avoid:

- `ingest/`
- `worker/`
- generated data files

### Data Loading Contract Changes

Read:

- `docs/DATA_CONTRACTS.md`
- `lib/data.ts`
- `lib/live.ts`
- `ingest/README.md`
- relevant ingest code only after understanding the contract

Potential writes:

- `docs/DATA_CONTRACTS.md`
- `lib/data.ts`
- future Worker API client code

### NEMWEB Ingest Changes

Read:

- `ingest/README.md`
- `ingest/ingest.py`
- `ingest/nemweb.py`
- `ingest/rankings.py` if rankings are involved
- `tests/test_ingest.py`
- `ingest/test_parser.py`

Use fixtures selectively:

- `tests/fixtures/generate_fixtures.py`
- specific CSV fixture files only when reproducing parser behavior

### Live Data Changes

Read:

- `lib/live.ts`
- `lib/useLiveData.ts`
- `scripts/fetch_live.py`
- `worker/README.md`
- `worker/src/index.ts`

Remember:

- current Worker is a cron dispatcher, not the browser data API
- current browser live data comes from the `live-data` branch via
  `raw.githubusercontent.com`

### Worker API Migration

Read:

- `docs/ARCHITECTURE.md`
- `docs/WORKSTREAMS.md`
- `docs/DATA_CONTRACTS.md`
- `docs/DECISIONS/0001-cloudflare-runtime.md`
- `worker/README.md`
- `worker/src/index.ts`
- `worker/wrangler.toml`

Key constraint:

- preserve the existing cron dispatch behavior until intentionally replaced

### Tests

Read:

- `tests/test_ingest.py`
- `tests/test_fetch_live.py`
- `ingest/test_parser.py`
- package files for available commands

Commands documented today:

- frontend build: `npm run build`
- ingest tests from `ingest/`: `uv run python -m pytest -q`
- worker build/type checks depend on `worker/package.json`

## Repo Map

- `AGENTS.md` - agent-facing repo instructions.
- `README.md` - current app overview and deployment notes.
- `FLAGS.md` - validation notes and open flags.
- `next.config.js` - static export and base path configuration.
- `package.json` - frontend scripts and dependencies.
- `.github/workflows/` - CI, deploy, ingest, live-data, and Worker automation.
- `app/` - Next.js app files.
- `components/` - chart and UI components.
- `lib/` - frontend data clients, live-data client, CSV helpers.
- `ingest/` - Python NEMWEB ingest implementation.
- `scripts/` - operational helper scripts.
- `worker/` - current Cloudflare Worker cron dispatcher.
- `tests/` - tests and fixtures.
- `public/data/` - generated data payloads; avoid broad reads.
- `docs/` - architecture/context scaffolding.

## Generated Data Guidance

If a task requires checking generated data:

1. Prefer schema docs and TypeScript/Python contracts first.
2. Read one targeted file, not all files.
3. Use shell tools that summarize shape or keys where possible.
4. Do not paste large JSON into responses or docs.
5. Treat generated files as outputs owned by ingest unless the task explicitly
   requires regenerating or validating them.
