import { describe, expect, it } from 'vitest';
import { buildForecastErrorData } from './forecastErrorData';
import { REGIONS, type Metric, type RegionData } from './data';
import type { LiveRegion } from './live';

const intervals = [
  '2026-05-28T00:30:00+10:00',
  '2026-05-28T01:00:00+10:00',
  '2026-05-28T01:30:00+10:00',
];

function metric(values: {
  poe10: number[];
  poe50: number[];
  poe90: number[];
  actual: (number | null)[];
}): Metric {
  return { intervals, ...values };
}

function regionData(seed = 0): RegionData {
  return {
    demand: metric({
      poe10: [130 + seed, 140 + seed, 150 + seed],
      poe50: [100 + seed, 110 + seed, 120 + seed],
      poe90: [70 + seed, 80 + seed, 90 + seed],
      actual: [112 + seed, null, 105 + seed],
    }),
    rooftopPv: metric({
      poe10: [45 + seed, 55 + seed, 65 + seed],
      poe50: [40 + seed, 50 + seed, 60 + seed],
      poe90: [35 + seed, 45 + seed, 55 + seed],
      actual: [34 + seed, 47 + seed, 70 + seed],
    }),
  };
}

function regionsWith(factory: (index: number) => RegionData) {
  return Object.fromEntries(REGIONS.map((region, index) => [region, factory(index)])) as Record<
    (typeof REGIONS)[number],
    RegionData
  >;
}

describe('buildForecastErrorData', () => {
  it('computes demand error, rooftop contribution, and residual', () => {
    const result = buildForecastErrorData({
      regions: regionsWith(() => regionData()),
      region: 'NSW1',
    });

    expect(result.points[0]).toMatchObject({
      demandError: 12,
      rooftopContribution: 6,
      residual: 6,
    });
  });

  it('skips intervals with missing demand or rooftop actuals', () => {
    const result = buildForecastErrorData({
      regions: regionsWith(() => regionData()),
      region: 'NSW1',
    });

    expect(result.points.map((point) => point.time)).toEqual(['00:30', '01:30']);
  });

  it('sums NEM forecasts and actuals before computing errors', () => {
    const regions = regionsWith((index) => ({
      demand: metric({
        poe10: [130 + index, 140 + index, 150 + index],
        poe50: [100 + index, 110 + index, 120 + index],
        poe90: [70 + index, 80 + index, 90 + index],
        actual: [105 + index, 115 + index, 125 + index],
      }),
      rooftopPv: metric({
        poe10: [45 + index, 55 + index, 65 + index],
        poe50: [40 + index, 50 + index, 60 + index],
        poe90: [35 + index, 45 + index, 55 + index],
        actual: [42 + index, 46 + index, 64 + index],
      }),
    }));

    const result = buildForecastErrorData({ regions, region: 'NEM' });

    expect(result.points[0].demandError).toBe(25);
    expect(result.points[0].rooftopContribution).toBe(-10);
    expect(result.points[0].residual).toBe(35);
  });

  it('returns null interval explained percentage when demand error is zero', () => {
    const regions = regionsWith(() => ({
      demand: metric({
        poe10: [130, 140, 150],
        poe50: [100, 110, 120],
        poe90: [70, 80, 90],
        actual: [100, 110, 120],
      }),
      rooftopPv: metric({
        poe10: [45, 55, 65],
        poe50: [40, 50, 60],
        poe90: [35, 45, 55],
        actual: [40, 50, 60],
      }),
    }));

    const result = buildForecastErrorData({ regions, region: 'NSW1' });

    expect(result.points.map((point) => point.rooftopExplainedPct)).toEqual([null, null, null]);
  });

  it('aligns 5-minute demand actuals to the latest point at or before each interval end', () => {
    const liveRegions: Record<string, LiveRegion> = {
      NSW1: {
        demand: [
          { ts: '2026-05-28T00:25:00+10:00', value: 999 },
          { ts: '2026-05-28T00:29:00+10:00', value: 111 },
          { ts: '2026-05-28T00:55:00+10:00', value: 118 },
        ],
        rooftopPv: [
          { ts: '2026-05-28T00:30:00+10:00', value: 38 },
          { ts: '2026-05-28T01:00:00+10:00', value: 45 },
        ],
      },
    };

    const result = buildForecastErrorData({
      regions: regionsWith(() => regionData()),
      region: 'NSW1',
      liveRegions,
    });

    expect(result.points.map((point) => [point.time, point.demandError, point.rooftopContribution])).toEqual([
      ['00:30', 11, 2],
      ['01:00', 8, 5],
    ]);
  });

  it('does not carry a half-hour rooftop actual into the next forecast-error interval', () => {
    const liveRegions: Record<string, LiveRegion> = {
      NSW1: {
        demand: [
          { ts: '2026-05-28T00:29:00+10:00', value: 111 },
          { ts: '2026-05-28T00:59:00+10:00', value: 118 },
        ],
        rooftopPv: [
          { ts: '2026-05-28T00:30:00+10:00', value: 38 },
        ],
      },
    };

    const result = buildForecastErrorData({
      regions: regionsWith(() => regionData()),
      region: 'NSW1',
      liveRegions,
    });

    expect(result.points.map((point) => point.time)).toEqual(['00:30']);
  });
});
