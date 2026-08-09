# 0005: Solar-First Meteorological Workspace

Status: Accepted

Date: 2026-08-09

## Context

The first operational-context release led with operational-demand ramps and
placed the new panel above the established forecast charts. Meteorological
forecasters supporting AEMO need the weather-sensitive generation signal to be
the primary story, particularly rooftop and utility-scale solar. They also need
the familiar tracker to retain its existing visual priority.

## Decision

- Keep the forecast tracker as the default tab and put all new live operational
  functionality on a separate `Meteorological context` tab.
- Lead the new tab with rooftop PV, utility-scale solar, combined solar,
  solar ramps and residual demand.
- Define residual demand as operational demand less utility-scale solar. Do not
  subtract rooftop PV again because it is already excluded from operational
  demand.
- Accumulate bounded regional utility-solar and wind SCADA series in the
  current context object. R2 remains the latest-product store and the browser
  contract stays independent of source report layouts.
- Use rooftop forecasts plus PDPASA utility-solar UIGF for combined solar
  forecasts, and operational-demand forecasts less utility-solar UIGF for
  residual-demand forecasts.
- Treat wind as secondary weather-sensitive context; treat reserve/LOR as a
  consequence; place constraints/interconnectors in a collapsed system-response
  section.
- Brief on constraint violations, not routine binding constraints. Never infer
  meteorological causation, curtailment or outages from SCADA movement alone.

## Trade-offs

- Rooftop estimates are half-hourly while DUID SCADA is five-minute. The combined
  current solar estimate is useful but explicitly carries component timestamps.
- Utility-solar and wind history begins when this contract is deployed and
  accumulates during each trading day; it is not reconstructed from historical
  source files in the live path.
- PDPASA UIGF is the appropriate available forward regional utility-solar signal,
  but it is a forecast, not actual generation or a curtailment measure.
- A dedicated tab adds one navigation action but prevents the new workspace from
  displacing a familiar operational view.

## Revisit Later

- Add weather observations/nowcasts before attributing ramps to cloud, heat or
  wind phenomena.
- Add unit availability and semi-dispatch-cap evidence before diagnosing solar
  or wind curtailment.
- Evaluate five-minute rooftop area products as their operational history and
  source stability mature.
