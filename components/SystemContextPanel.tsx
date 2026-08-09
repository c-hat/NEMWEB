'use client';

import SolarResidualCharts from './SolarResidualCharts';
import { REGION_LABELS, type SelectableRegion } from '@/lib/dataClient';
import type {
  DuidAsset,
  ForecasterBriefing,
  ReserveRegion,
  RooftopArea,
  SystemContext,
} from '@/lib/systemContext';

interface Props {
  context: SystemContext;
  briefing: ForecasterBriefing | null;
  region: SelectableRegion;
  stale: boolean;
}

function fmtMw(value: number | null | undefined, signed = false): string {
  if (value == null) return '—';
  const rounded = Math.round(value).toLocaleString('en-AU');
  return `${signed && value > 0 ? '+' : ''}${rounded} MW`;
}

function hhmm(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}

function latestAreaValue(area: RooftopArea): number | null {
  for (let i = area.actual.length - 1; i >= 0; i--) {
    if (area.actual[i].value != null) return area.actual[i].value;
  }
  return null;
}

function nextAreaForecast(area: RooftopArea, now: string) {
  const forecast = area.forecast;
  if (!forecast) return null;
  const nowMs = Date.parse(now);
  const index = forecast.intervals.findIndex((interval) => Date.parse(interval) >= nowMs);
  if (index < 0) return null;
  return { ts: forecast.intervals[index], value: forecast.poe50[index] ?? null };
}

function reserveFor(context: SystemContext, region: SelectableRegion): ReserveRegion | null {
  if (region !== 'NEM') return context.reserve.regions[region] ?? null;
  const values = Object.values(context.reserve.regions);
  if (!values.length) return null;
  const minimum = values
    .filter((item) => item.minimumSurplusReserveMw != null)
    .sort((a, b) => (a.minimumSurplusReserveMw ?? Infinity) - (b.minimumSurplusReserveMw ?? Infinity))[0];
  return {
    minimumSurplusReserveMw: minimum?.minimumSurplusReserveMw ?? null,
    minimumAt: minimum?.minimumAt ?? null,
    worstLorCondition: Math.max(...values.map((item) => item.worstLorCondition ?? 0)),
    intervals: [],
  };
}

function renewableMovers(assets: DuidAsset[], region: SelectableRegion): DuidAsset[] {
  return assets
    .filter(
      (asset) =>
        (asset.fueltech === 'solar_utility' || asset.fueltech === 'wind') &&
        (region === 'NEM' || asset.region === region) &&
        asset.deltaMw != null &&
        Math.abs(asset.deltaMw) >= 1,
    )
    .sort((a, b) => Math.abs(b.deltaMw ?? 0) - Math.abs(a.deltaMw ?? 0))
    .slice(0, 10);
}

export default function SystemContextPanel({ context, briefing, region, stale }: Props) {
  const meteorology = context.meteorologicalContext?.regions[region];
  if (!meteorology) {
    return (
      <section className="system-context-panel" aria-label="Meteorological energy context">
        <div className="system-context-heading">
          <div>
            <p className="eyebrow">Live solar workspace</p>
            <h2>{REGION_LABELS[region]} meteorological context</h2>
          </div>
        </div>
        <p className="status">Establishing the solar and residual-demand baseline…</p>
      </section>
    );
  }
  const reserve = reserveFor(context, region);
  const areas = Object.values(context.rooftopPvAreas.areas).filter(
    (area) => region === 'NEM' || area.region === region,
  );
  const assets = renewableMovers(context.duidScada.assets, region);
  const changeIds = new Set((briefing?.changes ?? []).map((change) => change.eventId));
  const events = (briefing?.events ?? []).filter(
    (event) =>
      changeIds.has(event.id) &&
      (region === 'NEM' || event.scope.id === region || event.scope.region === region || event.scope.kind === 'constraint'),
  );
  const dispatchRegion = region === 'NEM' ? null : context.dispatch.regions[region];
  const solarDispatchGap = dispatchRegion
    ? (dispatchRegion.solarUigfMw ?? 0) - (dispatchRegion.solarClearedMw ?? 0)
    : null;

  return (
    <section className="system-context-panel" aria-label="Meteorological energy context">
      <div className="system-context-heading">
        <div>
          <p className="eyebrow">What changed since the last run</p>
          <h2>{REGION_LABELS[region]} solar and residual-demand briefing</h2>
        </div>
        <span className={`context-freshness${stale ? ' stale' : ''}`}>
          <span className="live-dot" />
          {stale ? 'Context stale' : `Updated ${hhmm(context.updatedAt)} AEST`}
        </span>
      </div>

      <p className="briefing-summary">{briefing?.summary ?? 'Briefing comparison is warming up.'}</p>
      {events.length > 0 ? (
        <ul className="briefing-list">
          {events.slice(0, 6).map((event) => (
            <li key={event.id} className={`severity-${event.severity}`}>
              <span>{event.severity}</span>
              <div><strong>{event.headline}</strong><small>{event.detail}</small></div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="definition-note">No selected-region meteorological change crossed the initial materiality thresholds.</p>
      )}

      <div className="system-metrics solar-metrics">
        <div><span>Total solar estimate</span><strong>{fmtMw(meteorology.solar.totalEstimateMw)}</strong></div>
        <div><span>Rooftop PV</span><strong>{fmtMw(meteorology.solar.rooftopPvMw)}</strong><small>{hhmm(meteorology.solar.rooftopObservedAt)} AEST</small></div>
        <div><span>Utility solar</span><strong>{fmtMw(meteorology.solar.utilityScaleMw)}</strong><small>{fmtMw(meteorology.solar.utilityDeltaMw, true)} since last run</small></div>
        <div><span>30-minute solar change</span><strong>{fmtMw(meteorology.solar.rampsMw['30m'], true)}</strong></div>
        <div><span>Residual demand</span><strong>{fmtMw(meteorology.residualDemand.currentMw)}</strong></div>
        <div><span>30-minute residual change</span><strong>{fmtMw(meteorology.residualDemand.rampsMw['30m'], true)}</strong></div>
      </div>
      <p className="definition-note timing-note">
        Total solar combines the latest half-hour rooftop estimate with five-minute utility SCADA; component times are shown where they differ.
      </p>

      <SolarResidualCharts data={meteorology} />

      <div className="meteorology-support-grid">
        <section>
          <h3>Rooftop PV load areas</h3>
          <p className="definition-note">Spatial solar signal for load forecasting; next POE50 forecast and estimate quality are shown.</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Area</th><th>Actual</th><th>Next forecast</th><th>QI</th></tr></thead>
              <tbody>
                {areas.map((area) => {
                  const latest = area.actual.at(-1);
                  const forecast = nextAreaForecast(area, context.updatedAt);
                  return (
                    <tr key={area.areaId}>
                      <td>{area.label}</td>
                      <td>{fmtMw(latestAreaValue(area))}</td>
                      <td>{forecast ? `${fmtMw(forecast.value)} · ${hhmm(forecast.ts)}` : '—'}</td>
                      <td>{latest?.quality == null ? '—' : latest.quality.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h3>Renewable SCADA movers</h3>
          <p className="definition-note">Largest solar and wind movements since the prior run; cause is not inferred.</p>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>DUID</th><th>Type</th><th>SCADA</th><th>Δ</th></tr></thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.duid}>
                    <td title={asset.facilityName ?? asset.duid}>{asset.duid}</td>
                    <td>{asset.fueltech === 'solar_utility' ? 'solar' : 'wind'}</td>
                    <td>{fmtMw(asset.currentMw)}</td>
                    <td>{fmtMw(asset.deltaMw, true)}</td>
                  </tr>
                ))}
                {assets.length === 0 && <tr><td colSpan={4}>No renewable movement above 1 MW this run.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div className="weather-sensitive-strip">
        <div><span>Wind SCADA</span><strong>{fmtMw(meteorology.wind.currentMw)}</strong><small>{fmtMw(meteorology.wind.deltaMw, true)} since last run</small></div>
        <div><span>Wind 30-minute change</span><strong>{fmtMw(meteorology.wind.rampsMw['30m'], true)}</strong></div>
        {region !== 'NEM' && <div><span>Solar UIGF less cleared</span><strong>{fmtMw(solarDispatchGap)}</strong><small>Dispatch gap—not labelled curtailment</small></div>}
      </div>

      <details className="system-detail">
        <summary>Reserve and system response</summary>
        <p className="definition-note">These are system consequences and responses, not meteorological observations.</p>
        <div className="consequence-metrics">
          <div><span>Minimum 24h reserve</span><strong>{fmtMw(reserve?.minimumSurplusReserveMw)}</strong><small>{reserve?.minimumAt ? `${hhmm(reserve.minimumAt)} AEST` : '—'}</small></div>
          <div><span>Worst reserve condition</span><strong>{reserve?.worstLorCondition ? `LOR${reserve.worstLorCondition}` : 'No LOR'}</strong></div>
          <div><span>Binding constraints</span><strong>{context.dispatch.bindingConstraints.length}</strong></div>
        </div>
        <div className="system-detail-grid">
          <section>
            <h3>Binding constraints</h3>
            <div className="data-table-wrap"><table className="data-table">
              <thead><tr><th>Constraint</th><th>Marginal</th><th>Violation</th></tr></thead>
              <tbody>{context.dispatch.bindingConstraints.slice(0, 8).map((item) => (
                <tr key={item.constraintId}><td>{item.constraintId}</td><td>{item.marginalValue.toFixed(2)}</td><td>{item.violationDegree.toFixed(2)}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
          <section>
            <h3>Interconnectors</h3>
            <div className="data-table-wrap"><table className="data-table">
              <thead><tr><th>Interconnector</th><th>Metered</th><th>Target</th></tr></thead>
              <tbody>{context.dispatch.interconnectors.map((item) => (
                <tr key={item.interconnectorId}><td>{item.interconnectorId}</td><td>{fmtMw(item.meteredMw, true)}</td><td>{fmtMw(item.targetMw, true)}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
        </div>
      </details>
      {context.quality.status === 'partial' && (
        <p className="context-quality">Some sources are carried forward: {context.quality.errors.map((error) => error.source).join(', ')}.</p>
      )}
    </section>
  );
}
