import type { DayData, Metric, RegionData } from '@/lib/data';

export const fixtureMetric: Metric = {
  intervals: [
    '2026-05-28T00:30:00+10:00',
    '2026-05-28T01:00:00+10:00',
    '2026-05-28T01:30:00+10:00',
  ],
  poe10: [120, 140, 160],
  poe50: [100, 120, 140],
  poe90: [80, 100, 120],
  actual: [95, null, 150],
};

export const fixtureRegionData: RegionData = {
  demand: fixtureMetric,
  rooftopPv: {
    intervals: fixtureMetric.intervals,
    poe10: [45, 55, 65],
    poe50: [40, 50, 60],
    poe90: [35, 45, 55],
    actual: [38, null, 62],
  },
};

export const fixtureDayData: DayData = {
  tradingDate: '2026-05-28',
  forecastIssuedAt: '2026-05-27T17:00:00+10:00',
  regions: {
    NSW1: fixtureRegionData,
    VIC1: fixtureRegionData,
    QLD1: fixtureRegionData,
    SA1: fixtureRegionData,
    TAS1: fixtureRegionData,
  },
};
