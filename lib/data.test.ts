import { describe, expect, it } from 'vitest';
import { buildNemRegion, formatIssued, REGIONS, type Metric, type RegionData } from './data';

function metric(seed: number): Metric {
  return {
    intervals: [
      '2026-05-28T00:30:00+10:00',
      '2026-05-28T01:00:00+10:00',
      '2026-05-28T01:30:00+10:00',
    ],
    poe10: [100 + seed, seed === 2 ? null : 120 + seed, 130 + seed],
    poe50: [90 + seed, seed === 3 ? null : 110 + seed, 120 + seed],
    poe90: [80 + seed, seed === 4 ? null : 100 + seed, 110 + seed],
    actual: [95 + seed, seed === 1 ? null : 115 + seed, 125 + seed],
  };
}

function regionData(seed: number): RegionData {
  return {
    demand: metric(seed),
    rooftopPv: metric(seed + 10),
  };
}

describe('buildNemRegion', () => {
  it('sums all regions interval-by-interval and preserves interval labels', () => {
    const regions = Object.fromEntries(REGIONS.map((region, index) => [region, regionData(index)]));

    const nem = buildNemRegion(regions as Record<(typeof REGIONS)[number], RegionData>);

    expect(nem.demand.intervals).toEqual(metric(0).intervals);
    expect(nem.demand.poe10).toEqual([510, null, 660]);
    expect(nem.demand.poe50).toEqual([460, null, 610]);
    expect(nem.demand.poe90).toEqual([410, null, 560]);
    expect(nem.demand.actual).toEqual([485, null, 635]);
  });

  it('propagates null values instead of dropping intervals', () => {
    const regions = Object.fromEntries(REGIONS.map((region, index) => [region, regionData(index)]));

    const nem = buildNemRegion(regions as Record<(typeof REGIONS)[number], RegionData>);

    expect(nem.demand.poe10).toHaveLength(3);
    expect(nem.demand.poe10[1]).toBeNull();
    expect(nem.demand.actual[1]).toBeNull();
  });
});

describe('formatIssued', () => {
  it('formats issued timestamps in fixed AEST display time', () => {
    expect(formatIssued('2026-05-27T17:00:00+10:00')).toBe(
      '5:00pm AEST, Wed 27 May 2026',
    );
  });

  it('returns the original string when the timestamp is invalid', () => {
    expect(formatIssued('not-a-date')).toBe('not-a-date');
  });
});
