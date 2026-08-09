'use client';

import OperationalDemandRampChart from './OperationalDemandRampChart';
import { REGION_LABELS, type SelectableRegion } from '@/lib/dataClient';
import type { ForecastSeries, LivePoint } from '@/lib/live';
import type {
  DuidAsset,
  ForecasterBriefing,
  ReserveRegion,
  SystemContext,
} from '@/lib/systemContext';

interface Props {
  context: SystemContext;
  briefing: ForecasterBriefing | null;
  region: SelectableRegion;
  demandActual: LivePoint[];
  demandForecast?: ForecastSeries;
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

function latestAreaValue(points: Array<{ value: number | null }>): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].value != null) return points[i].value;
  }
  return null;
}

function reserveFor(context: SystemContext, region: SelectableRegion): ReserveRegion | null {
  if (region !== 'NEM') return context.reserve.regions[region] ?? null;
  const values = Object.values(context.reserve.regions);
  if (!values.length) return null;
  const reserveValues = values.filter((item) => item.minimumSurplusReserveMw != null);
  const minimum = reserveValues.sort(
    (a, b) => (a.minimumSurplusReserveMw ?? Infinity) - (b.minimumSurplusReserveMw ?? Infinity),
  )[0];
  return {
    minimumSurplusReserveMw: minimum?.minimumSurplusReserveMw ?? null,
    minimumAt: minimum?.minimumAt ?? null,
    worstLorCondition: Math.max(...values.map((item) => item.worstLorCondition ?? 0)),
    intervals: [],
  };
}

function selectedAssets(assets: DuidAsset[], region: SelectableRegion): DuidAsset[] {
  const scoped = region === 'NEM' ? assets : assets.filter((asset) => asset.region === region);
  return scoped
    .filter((asset) => asset.deltaMw != null)
    .sort((a, b) => Math.abs(b.deltaMw ?? 0) - Math.abs(a.deltaMw ?? 0))
    .slice(0, 10);
}

export default function SystemContextPanel({
  context,
  briefing,
  region,
  demandActual,
  demandForecast,
  stale,
}: Props) {
  const metrics = context.regions[region];
  if (!metrics) return null;
  const reserve = reserveFor(context, region);
  const areas = Object.values(context.rooftopPvAreas.areas).filter(
    (area) => region === 'NEM' || area.region === region,
  );
  const assets = selectedAssets(context.duidScada.assets, region);
  const changeIds = new Set((briefing?.changes ?? []).map((change) => change.eventId));
  const events = (briefing?.events ?? []).filter(
    (event) =>
      changeIds.has(event.id) &&
      (region === 'NEM' ||
        event.scope.id === region ||
        event.scope.region === region ||
        event.scope.kind === 'constraint'),
  );

  return (
    <section className="system-context-panel" aria-label="Live NEM system context">
      <div className="system-context-heading">
        <div>
          <p className="eyebrow">What changed since the last run</p>
          <h2>{REGION_LABELS[region]} system briefing</h2>
        </div>
        <span className={`context-freshness${stale ? ' stale' : ''}`}>
          <span className="live-dot" />
          {stale ? 'Context stale' : `Updated ${hhmm(context.updatedAt)} AEST`}
        </span>
      </div>

      <p className="briefing-summary">{briefing?.summary ?? 'Briefing comparison is warming up.'}</p>
      {events.length > 0 ? (
        <ul className="briefing-list">
          {events.slice(0, 5).map((event) => (
            <li key={event.id} className={`severity-${event.severity}`}>
              <span>{event.severity}</span>
              <div>
                <strong>{event.headline}</strong>
                <small>{event.detail}</small>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="definition-note">No selected-region change crossed the initial materiality thresholds.</p>
      )}

      <div className="system-metrics">
        <div>
          <span>Grid demand now</span>
          <strong>{fmtMw(metrics.operationalDemand.currentMw)}</strong>
        </div>
        <div>
          <span>30-minute ramp</span>
          <strong>{fmtMw(metrics.operationalDemand.rampsMw['30m'], true)}</strong>
        </div>
        <div>
          <span>60-minute ramp</span>
          <strong>{fmtMw(metrics.operationalDemand.rampsMw['60m'], true)}</strong>
        </div>
        <div>
          <span>Underlying demand</span>
          <strong>{fmtMw(metrics.underlyingDemand.currentMw)}</strong>
        </div>
        <div>
          <span>Minimum 24h reserve</span>
          <strong>{fmtMw(reserve?.minimumSurplusReserveMw)}</strong>
          <small>{reserve?.minimumAt ? `${hhmm(reserve.minimumAt)} AEST` : '—'}</small>
        </div>
        <div>
          <span>Worst reserve condition</span>
          <strong>{reserve?.worstLorCondition ? `LOR${reserve.worstLorCondition}` : 'No LOR'}</strong>
        </div>
      </div>

      <OperationalDemandRampChart actual={demandActual} forecast={demandForecast} />

      <details className="system-detail">
        <summary>Rooftop PV areas, DUID SCADA, reserve and network detail</summary>
        <div className="system-detail-grid">
          <section>
            <h3>Rooftop PV load areas</h3>
            <p className="definition-note">Latest AEMO area estimate; quality index is shown where supplied.</p>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Area</th><th>Actual</th><th>QI</th></tr></thead>
                <tbody>
                  {areas.map((area) => {
                    const latest = area.actual.at(-1);
                    return (
                      <tr key={area.areaId}>
                        <td>{area.label}</td>
                        <td>{fmtMw(latestAreaValue(area.actual))}</td>
                        <td>{latest?.quality == null ? '—' : latest.quality.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3>DUID SCADA movers</h3>
            <p className="definition-note">Change since the previous run. Movement is observed; cause is not inferred.</p>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>DUID</th><th>Fuel</th><th>SCADA</th><th>Δ</th></tr></thead>
                <tbody>
                  {assets.map((asset) => (
                    <tr key={asset.duid}>
                      <td title={asset.facilityName ?? asset.duid}>{asset.duid}</td>
                      <td>{asset.fueltech?.replaceAll('_', ' ') ?? '—'}</td>
                      <td>{fmtMw(asset.currentMw)}</td>
                      <td>{fmtMw(asset.deltaMw, true)}</td>
                    </tr>
                  ))}
                  {assets.length === 0 && <tr><td colSpan={4}>Waiting for a previous-run comparison.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3>Binding constraints</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Constraint</th><th>Marginal</th><th>Violation</th></tr></thead>
                <tbody>
                  {context.dispatch.bindingConstraints.slice(0, 8).map((item) => (
                    <tr key={item.constraintId}>
                      <td>{item.constraintId}</td>
                      <td>{item.marginalValue.toFixed(2)}</td>
                      <td>{item.violationDegree.toFixed(2)}</td>
                    </tr>
                  ))}
                  {context.dispatch.bindingConstraints.length === 0 && <tr><td colSpan={3}>None reported.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3>Interconnectors</h3>
            <p className="definition-note">Signed AEMO metered flow and dispatch target.</p>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Interconnector</th><th>Metered</th><th>Target</th></tr></thead>
                <tbody>
                  {context.dispatch.interconnectors.map((item) => (
                    <tr key={item.interconnectorId}>
                      <td>{item.interconnectorId}</td>
                      <td>{fmtMw(item.meteredMw, true)}</td>
                      <td>{fmtMw(item.targetMw, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        {context.quality.status === 'partial' && (
          <p className="context-quality">Some context sources are carried forward: {context.quality.errors.map((e) => e.source).join(', ')}.</p>
        )}
      </details>
    </section>
  );
}
