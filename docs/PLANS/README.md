# Workstream Plans

One plan per workstream from [`docs/WORKSTREAMS.md`](../WORKSTREAMS.md). Each plan
is written to be handed directly to an agent: it states the current (verified)
state, dependencies on other workstreams, an ordered task list, the contracts to
honour, acceptance criteria, and guardrails.

Target end state for all plans: the **full Cloudflare migration** described in
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) and
[`docs/DECISIONS/0001-cloudflare-runtime.md`](../DECISIONS/0001-cloudflare-runtime.md)
— Pages frontend, Worker API as the only browser data boundary, R2 for payload
bodies, D1 for catalog/metadata, analyses as versioned derived datasets.

## Plans

1. [Frontend Views](01-frontend.md) — charts, controls, CSV, view definitions.
2. [Ingest & Source Adapters](02-ingest.md) — fetch/parse/normalize sources.
3. [Storage & Catalog](03-storage-catalog.md) — R2 layout + D1 schema.
4. [Worker API](04-worker-api.md) — the browser-facing data boundary.
5. [Analysis](05-analysis.md) — derived datasets (errors, breaches, overlays).
6. [CI & Deployment](06-ci-deployment.md) — build/test/deploy/schedule.

Plus [VERIFICATION.md](VERIFICATION.md) — how to verify each workstream and that
they work together, with the cutover order.

## How the work is run

Workstreams are tackled **sequentially in one terminal session** — one stream in
flight at a time, reviewed before the next. There is no orchestrator agent; the
coordination that an orchestrator would provide lives in two artifacts instead:
this README's dependency order, and [VERIFICATION.md](VERIFICATION.md)'s gates +
cutover note. Verify each layer against the kept-alive old path before moving on.

## Dependency order

The streams are not independent. A pragmatic sequencing:

```
Storage&Catalog (03) ─┐
Ingest (02) ──────────┼─► Worker API (04) ─► Frontend (01) reads API
Analysis (05) ────────┘                       CI&Deployment (06) wraps all
```

- **02 Ingest** and **05 Analysis** produce the payloads that **03 Storage**
  organises and **04 Worker API** serves.
- **01 Frontend** is the last to flip from static `public/data` reads to the
  Worker API, behind a feature flag, so it can ship continuously.
- **06 CI/Deployment** changes track each stream as it lands (R2/D1 provisioning,
  Pages cutover, scheduled jobs).

## Cross-cutting rules (apply to every plan)

- Preserve the working static app until the Worker API replacement is live and
  tested. Do **not** delete `public/data` or break the cron dispatcher casually.
- Keep the four concepts separate in naming, contracts, and ownership: **source
  ≠ dataset ≠ analysis ≠ visualisation**.
- Add documented contracts *before* changing behaviour. Update
  [`docs/DATA_CONTRACTS.md`](../DATA_CONTRACTS.md) in the same change that alters
  a shape.
- Missing numeric values are `null`, never dropped intervals. Trading dates are
  `YYYY-MM-DD`. Interval timestamps are interval-ending, fixed AEST `+10:00`.
- Do not expose R2 object keys or D1 table layouts as frontend contracts.
- Do not read `public/data/**` wholesale; use one sample file when a shape needs
  confirming.
