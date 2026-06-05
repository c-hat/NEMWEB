# Plan: Frontend Views

Workstream 1 in [`docs/WORKSTREAMS.md`](../WORKSTREAMS.md). Owns `app/`,
`components/`, frontend `lib/` clients, and frontend tests.

## Current state (verified)

- Next.js 15 static export (`output: 'export'`), React 19, Recharts 2.15.
- `app/page.tsx` (350 lines) composes the page; `components/ForecastChart.tsx`
  (524 lines) is the single chart component; `app/globals.css` (348 lines).
- Data clients: `lib/data.ts` (static `public/data/*.json` fetches + the
  `DayData`/`Metric`/`Rankings` contracts + `buildNemRegion` aggregation),
  `lib/live.ts` (live file over `raw.githubusercontent.com`),
  `lib/useLiveData.ts` (polling hook, pauses on hidden tab), `lib/csv.ts`
  (CSV export).
- **No frontend tests exist.** No component/unit test runner is configured in
  `package.json` (only `next lint`).
- The app works today and is deployed to GitHub Pages.

## Finalisation target

The frontend renders **view definitions** that consume datasets and analyses
through the Worker API (workstream 4), not through static files or source
adapters. It ships continuously: keep static reads working until the API is live,
then flip behind a flag.

## Dependencies

- **Worker API (04)** for the data boundary. Until its endpoints exist, the
  frontend keeps reading `public/data` and the live branch.
- **Analysis (05)** for the descriptors/payloads that drive analysis views.

## Tasks (ordered)

### Phase A — harden the prototype (no API dependency)

1. **Add a frontend test harness.** Install Vitest + React Testing Library (or
   Playwright for the chart smoke test). Add `test` and `test:watch` scripts to
   `package.json`. Wire into the `test` CI workflow (workstream 6) as a second
   job so JS tests run alongside the Python suite.
2. **Unit-test the data layer.** Cover `buildNemRegion`/`sumSeries` null
   propagation, `formatIssued` AEST formatting, and `lib/csv.ts` output. These
   are pure functions and high-value.
3. **Component smoke tests.** Render `ForecastChart` with a fixture `DayData`;
   assert POE band ordering and the LIVE/STALE badge states from
   `useLiveData`. Add a tiny fixture (one region, a few intervals) under a new
   `__fixtures__/` — do not import generated `public/data`.
4. **Split `ForecastChart.tsx`.** At 524 lines it mixes data shaping, the live
   overlay, and rendering. Extract series-shaping helpers into a testable module
   and keep the component presentational. Behaviour-preserving refactor.
5. **Accessibility/empty states.** Verify chart has accessible labels and that
   missing-day / failed-fetch / no-`today.json` paths degrade gracefully.

### Phase B — introduce the API client seam (parallel with workstream 4)

6. **Define a `lib/api.ts` client** mirroring the Worker API
   ([`docs/DATA_CONTRACTS.md`](../DATA_CONTRACTS.md) §Target Worker API):
   `getCatalog`, `getDays`, `getLatest`, `getDay(date)`, `getLive`,
   `getAnalyses`, `getAnalysis(id)`. It returns the **same TypeScript types** as
   `lib/data.ts` for the compatibility shapes, so views are source-agnostic.
7. **Feature-flag the data source.** A build-time flag (e.g.
   `NEXT_PUBLIC_DATA_SOURCE=static|api`) selects `lib/data.ts` vs `lib/api.ts`
   behind a single facade the views import. Default `static` until the API is
   proven.
8. **Migrate live data through the API.** Replace the direct
   `raw.githubusercontent.com` fetch in `lib/live.ts` with `GET /api/live` once
   that endpoint exists; keep the raw URL as a fallback behind the flag.

### Phase C — view definitions & analysis views (after 04/05)

9. **Introduce a view-definition layer.** Describe each visualisation
   (forecast-vs-actual, error ranking, future band-breach / regional-contribution
   / weather / price overlays) as a declarative descriptor that maps an analysis
   or dataset id to a chart component. Render from `GET /api/analyses`.
10. **Flip the default to `api`** once Pages serves the frontend and the Worker
    API is the data boundary. Remove static-only code paths only after a release
    has run on `api` in production.

## Contracts to honour

- The compatibility types in `lib/data.ts` (`DayData`, `Metric`, `IndexEntry`,
  `LatestEntry`, `Rankings`) are the migration contract — the API must return
  these shapes first. Any change goes through `docs/DATA_CONTRACTS.md`.
- POE convention `poe10 >= poe50 >= poe90` for both metrics.
- Display times are AEST; keep `Australia/Brisbane` formatting.

## Acceptance criteria

- `npm run build` produces a static export with no errors.
- Frontend tests run in CI and cover the data layer + one chart smoke test.
- A single env flag switches every view between static and API data with no
  visual change on the compatibility shapes.
- Live overlay works through `GET /api/live` with the raw-URL fallback removable.

## Guardrails

- Do not put source-specific parsing into React components.
- Do not read `public/data/**` wholesale; use a small fixture.
- Do not remove static read paths until a production release has run on `api`.
- Behaviour-preserving refactors must keep the current chart output identical.
