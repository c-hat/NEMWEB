import { describe, expect, it } from 'vitest';
import { buildLiveOnlyDayData, currentAestDate, liveTradingDate } from './liveDay';
import type { LiveFile } from './live';

describe('currentAestDate', () => {
  it('formats the current trading date in fixed AEST', () => {
    expect(currentAestDate(new Date('2026-06-05T16:05:00Z'))).toBe('2026-06-06');
  });
});

describe('liveTradingDate', () => {
  it('uses live point timestamps before updatedAt', () => {
    const file: LiveFile = {
      updatedAt: '2026-06-05T13:30:00Z',
      regions: {
        NEM: {
          demand: [{ ts: '2026-06-06T00:05:00+10:00', value: 22000 }],
          rooftopPv: [],
        },
      },
    };

    expect(liveTradingDate(file)).toBe('2026-06-06');
  });

  it('falls back to updatedAt when live series are empty', () => {
    const file: LiveFile = {
      updatedAt: '2026-06-05T16:05:00Z',
      regions: {},
    };

    expect(liveTradingDate(file)).toBe('2026-06-06');
  });
});

describe('buildLiveOnlyDayData', () => {
  it('builds an empty 48-interval day for live overlays', () => {
    const day = buildLiveOnlyDayData('2026-06-06');

    expect(day.tradingDate).toBe('2026-06-06');
    expect(day.forecastIssuedAt).toBe('');
    expect(day.regions.NSW1.demand.intervals[0]).toBe('2026-06-06T00:30+10:00');
    expect(day.regions.NSW1.demand.intervals.at(-1)).toBe('2026-06-07T00:00+10:00');
    expect(day.regions.NSW1.demand.poe50).toHaveLength(48);
    expect(day.regions.NSW1.demand.poe50.every((value) => value === null)).toBe(true);
  });
});
