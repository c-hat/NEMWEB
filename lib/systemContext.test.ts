import { describe, expect, it } from 'vitest';
import { buildDemandRamps } from './systemContext';

describe('buildDemandRamps', () => {
  it('builds observed rolling and forecast interval ramps', () => {
    const actual = [
      { ts: '2026-08-09T08:00:00+10:00', value: 1000 },
      { ts: '2026-08-09T08:05:00+10:00', value: 1020 },
      { ts: '2026-08-09T08:30:00+10:00', value: 1150 },
    ];
    const forecast = {
      intervals: ['2026-08-09T08:00:00+10:00', '2026-08-09T08:30:00+10:00'],
      poe50: [990, 1100],
    };

    const result = buildDemandRamps(actual, forecast);
    expect(result.find((point) => point.time === '08:30')).toMatchObject({
      observedRampMw: 150,
      forecastRampMw: 110,
    });
  });

  it('does not manufacture a ramp without a full comparison window', () => {
    const result = buildDemandRamps([
      { ts: '2026-08-09T08:00:00+10:00', value: 1000 },
      { ts: '2026-08-09T08:20:00+10:00', value: 1100 },
    ]);
    expect(result).toEqual([]);
  });
});
