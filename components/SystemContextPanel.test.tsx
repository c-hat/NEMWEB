import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import SystemContextPanel from './SystemContextPanel';
import type { ForecasterBriefing, SystemContext } from '@/lib/systemContext';

const ts = '2026-08-09T12:00:00+10:00';

const context = {
  schemaVersion: '1.1.0',
  updatedAt: '2026-08-09T02:00:00Z',
  tradingDate: '2026-08-09',
  sources: {},
  regions: {},
  currentForecast: {},
  rooftopPvAreas: {
    actualIssuedAt: ts,
    forecastIssuedAt: ts,
    areas: {
      NSW1: {
        areaId: 'NSW1',
        label: 'New South Wales',
        region: 'NSW1',
        actual: [{ ts, value: 1200, quality: 0.98 }],
        forecast: { intervals: [ts], mean: [1250], poe50: [1250], poe10: [1350], poe90: [1150] },
      },
    },
  },
  duidScada: {
    observedAt: ts,
    assets: [
      { duid: 'SOLAR1', region: 'NSW1', fueltech: 'solar_utility', observedAt: ts, currentMw: 2000, deltaMw: -100 },
      { duid: 'GAS1', region: 'NSW1', fueltech: 'gas_ocgt', observedAt: ts, currentMw: 100, deltaMw: 50 },
    ],
  },
  dispatch: {
    observedAt: ts,
    regions: { NSW1: { solarUigfMw: 2010, solarClearedMw: 2000 } },
    bindingConstraints: [{ constraintId: 'N_TEST', rhs: 100, lhs: 100, marginalValue: 10, violationDegree: 0 }],
    interconnectors: [{ interconnectorId: 'N-Q-MNSP1', meteredMw: 50, targetMw: 55, exportLimitMw: 100, importLimitMw: 100, marginalValue: 0, violationDegree: 0 }],
  },
  reserve: {
    runAt: ts,
    horizonHours: 24,
    regions: { NSW1: { minimumSurplusReserveMw: 900, minimumAt: ts, worstLorCondition: 0, intervals: [] } },
  },
  meteorologicalContext: {
    definition: 'solar generation and demand remaining after utility-scale solar',
    regions: {
      NSW1: {
        solar: {
          rooftopPvMw: 1200,
          rooftopObservedAt: ts,
          utilityScaleMw: 2000,
          utilityObservedAt: ts,
          utilityDeltaMw: -100,
          totalEstimateMw: 3200,
          rampsMw: { '30m': -250, '60m': -400 },
          series: [{ ts, rooftopPvMw: 1200, utilitySolarMw: 2000, utilityObservedAt: ts, totalSolarMw: 3200 }],
        },
        residualDemand: {
          currentMw: 6000,
          observedAt: ts,
          rampsMw: { '30m': 300, '60m': 500 },
          series: [{ ts, operationalDemandMw: 8000, utilitySolarMw: 2000, residualDemandMw: 6000 }],
        },
        utilitySolar: { currentMw: 2000, deltaMw: -100, observedAt: ts, series: [{ ts, value: 2000 }] },
        wind: { currentMw: 1500, deltaMw: 80, observedAt: ts, rampsMw: { '30m': 100, '60m': 200 }, series: [{ ts, value: 1500 }] },
        forecast: [{ ts, rooftopPvMw: 1200, utilitySolarUigfMw: 2100, totalSolarMw: 3300, operationalDemandMw: 8100, residualDemandMw: 6000, windUigfMw: 1550 }],
      },
    },
  },
  quality: { status: 'complete', errors: [] },
} satisfies SystemContext;

const briefing = {
  schemaVersion: '1.1.0',
  generatedAt: ts,
  comparedWith: '2026-08-09T11:50:00+10:00',
  summary: '1 material solar change since the previous run; 1 shown.',
  changes: [{ eventId: 'solar-ramp:NSW1', severity: 'watch', headline: 'NSW1 solar moved down', detail: 'Observed change.' }],
  events: [{ id: 'solar-ramp:NSW1', type: 'solar-ramp', status: 'active', severity: 'watch', scope: { kind: 'region', id: 'NSW1' }, observedAt: ts, headline: 'NSW1 solar moved down', detail: 'Observed change.', metrics: {}, evidence: ['aemo-rooftop-pv'], confidence: 'high' }],
} satisfies ForecasterBriefing;

describe('SystemContextPanel', () => {
  it('leads with solar and residual demand while keeping system response secondary', () => {
    render(<SystemContextPanel context={context} briefing={briefing} region="NSW1" stale={false} />);

    expect(screen.getByRole('heading', { name: /solar and residual-demand briefing/i })).toBeInTheDocument();
    expect(screen.getByText('3,200 MW')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Solar generation components chart' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Residual demand chart' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rooftop PV load areas' })).toBeInTheDocument();
    expect(screen.getByText('SOLAR1')).toBeInTheDocument();
    expect(screen.queryByText('GAS1')).not.toBeInTheDocument();
    expect(screen.getByText('Reserve and system response')).toBeInTheDocument();
    expect(screen.getByText(/Rooftop PV ends at 12:00 AEST/)).toBeInTheDocument();
    expect(screen.getByText(/Rooftop PV is not carried forward/)).toBeInTheDocument();
  });
});
