# 0004: Additive Live Operational Context And Event Products

Status: Accepted

Date: 2026-08-09

## Context

The established forecast charts are used operationally by meteorological
forecasters supporting AEMO. They need more energy-system context, but changing
the current live contract or making new sources prerequisites for the existing
charts would increase operational risk.

The requested first release covers operational-demand ramps, rooftop-PV load
areas, DUID SCADA, reserve and constraint context, plus a concise account of
what changed between ten-minute runs. Weather-dependent cut-out and cool-change
features remain out of scope until weather sources are selected.

## Decision

- Preserve `today-live.json` and `GET /api/live` without schema or behavior
  changes.
- Generate `system-context` as a separate current-state product and
  `forecaster-briefing` as a separate derived analysis product.
- Publish both to R2 and expose them through the Worker API. Keep the orphan
  `live-data` branch as an operational fallback during the migration.
- Load and poll the new frontend panel independently. Its failure must not set
  the existing page error state or prevent existing charts from rendering.
- Use explicit, versioned event records with evidence and confidence rather
  than embedding source-specific alert logic in React components.
- Treat SCADA deltas as observed movements only. Do not infer a trip,
  curtailment, cut-out or meteorological cause without supporting inputs.
- Keep payload bodies in R2. D1 remains the catalog/run/index store; it is not
  in the latency-sensitive current-product read path.

## Consequences

- A context-source failure produces a partial or carried-forward context while
  the compatibility live publish can still succeed.
- The first run after a reset cannot produce DUID or forecast-revision deltas;
  the comparison becomes useful on the next run.
- GitHub Actions remains the transitional source-adapter orchestrator. Moving
  fetching into Workers/Queues is possible later without changing browser
  contracts.
- Event thresholds are deliberately conservative first-release policy, not an
  assertion of AEMO operational alert thresholds.
- The Worker configuration uses current JSONC, generated binding/runtime types,
  structured logs, health endpoints, logs and sampled traces.

## Rejected Alternatives

- Extending `today-live.json`: rejected because it couples optional context to
  the stable chart contract and increases rollback risk.
- Parsing NEMWEB source rows in the browser: rejected because source formats
  are not frontend contracts.
- Requiring D1 to serve every live response: rejected because latest bounded
  objects map naturally to R2 and should remain available if catalog writes lag.
