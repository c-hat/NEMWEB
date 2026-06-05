# Plan: Analysis

Workstream 5 in [`docs/WORKSTREAMS.md`](../WORKSTREAMS.md). Owns analysis
modules, derived payload schemas, analysis tests, and analysis index metadata.

## Current state (verified)

- `ingest/rankings.py` (95 lines) is the **only** analysis today: it computes the
  demand forecast-error ranking and writes `public/data/demand-error-rankings.json`
  (`{ metric, topN, regions: { NEM, NSW1… : [{date, maeMw, meanSignedErrorMw,
  intervals}] } }`, consumed by `lib/data.ts` `fetchRankings`).
- It lives **inside ingest**, coupled to the per-day file layout — it is the
  prototype of an analysis, not yet a separate workstream artifact.
- The frontend's `buildNemRegion` (in `lib/data.ts`) does the NEM-sum
  client-side — a visualisation-time computation that the analysis layer could
  formalise.
- No analysis index, no versioning, no `inputs/parameters/generatedAt` metadata.
- Target analysis families and the `/api/analyses` contract are in
  [`docs/DATA_CONTRACTS.md`](../DATA_CONTRACTS.md) §Analysis Families / §Target
  Worker API.

## Finalisation target

Analyses are **versioned derived datasets** computed from normalized datasets
(not raw source formats), each with a stable id, declared inputs/parameters,
generated-at timestamp, and an availability entry in the catalog. They are stored
in R2 and indexed in D1, and served via `GET /api/analyses` /
`GET /api/analyses/:id`.

## Dependencies

- **Ingest (02)** for the normalized dataset contract analyses consume.
- **Storage & Catalog (03)** for where analysis payloads land (R2) and how
  availability is indexed (D1).
- **Worker API (04)** serves analysis descriptors and payloads.
- **Frontend (01)** Phase C renders analysis views from the descriptors.

## Tasks (ordered)

1. **Define the analysis payload contract** in
   [`docs/DATA_CONTRACTS.md`](../DATA_CONTRACTS.md): every analysis emits
   `{ id, type, version, inputs, parameters, generatedAt, data }`; descriptors
   emit `{ id, type, label, description, inputs, parameters, dateRange|availableDates,
   updatedAt }`. IDs identify the **analysis definition**, never a source file.
2. **Extract an analysis runner/registry.** A module where each analysis declares
   id, type, inputs (dataset ids + params) and a `compute(datasets, params)`.
   Move it out of `ingest/` into its own location (e.g. `analysis/`), so it
   depends on normalized datasets, not the ingest internals.
3. **Migrate the existing ranking** into the registry as
   `type: forecast-error-ranking`, producing the new payload+descriptor shape.
   Keep a compatibility projection equal to today's
   `demand-error-rankings.json` until the frontend switches.
4. **Add the remaining analysis families** from the contract, prioritised:
   - `forecast-vs-actual` (per day/region; formalises what the chart shows)
   - `band-breach` (intervals where actual falls outside poe10/poe90)
   - `regional-contribution` (each region's share; formalise the NEM aggregate
     currently done in `buildNemRegion`)
   - `weather-correlation` and `price-market-overlay` (require new source
     adapters from workstream 2 — sequence after those land)
5. **Write each analysis's tests** against fixtures (deterministic, no network),
   covering null handling and band-ordering edge cases.
6. **Emit analysis availability to the catalog** (workstream 3): write payloads
   to R2 `analysis/<id>/<version>.json` and rows to `analyses` /
   `analysis_availability`. The catalog generator then exposes them.

## Contracts to honour

- Analysis outputs are derived datasets with ids, inputs, parameters,
  timestamps, and **versioned semantics**.
- Do not hard-code chart assumptions into analysis outputs — they describe
  results, not pixels.
- Consume normalized datasets/fixtures, not bulk raw generated JSON.
- `null` for missing; AEST `+10:00`; `YYYY-MM-DD` dates.

## Acceptance criteria

- The ranking runs through the new registry and its compatibility projection
  equals current `demand-error-rankings.json` byte-for-byte.
- At least `forecast-error-ranking`, `band-breach`, and `regional-contribution`
  are implemented with tests.
- Each analysis produces a descriptor + versioned payload and an availability
  entry the catalog/API can serve.
- Adding a new analysis requires no change to ingest adapters or chart code.

## Guardrails

- Do not couple analyses to raw source formats.
- Do not read generated JSON in bulk when normalized datasets/fixtures suffice.
- Keep analysis separate from ingest and from visualisation in naming and code.
