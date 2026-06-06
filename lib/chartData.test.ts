import { describe, expect, it } from 'vitest';
import { fixtureMetric } from '@/__fixtures__/dayData';
import { buildForecastChartData, syncByNearestValue, yScale } from './chartData';

describe('buildForecastChartData', () => {
  it('keeps POE band ordering as [poe90, poe10]', () => {
    const rows = buildForecastChartData(fixtureMetric);

    expect(rows[0]).toMatchObject({
      t: 30,
      time: '00:30',
      band: [80, 120],
      poe50: 100,
      actual: 95,
    });
  });

  it('interpolates POE50 and bands for live-only rows', () => {
    const rows = buildForecastChartData(fixtureMetric, [
      { ts: '2026-05-28T00:45:00+10:00', value: 110 },
    ]);

    const liveRow = rows.find((row) => row.t === 45);
    expect(liveRow?.live).toBe(110);
    expect(liveRow?.poe50).toBe(110);
    expect(liveRow?.band).toEqual([90, 130]);
  });

  it('drops live rows outside the selected trading day', () => {
    const rows = buildForecastChartData(fixtureMetric, [
      { ts: '2026-05-29T00:30:00+10:00', value: 999 },
    ]);

    expect(rows.some((row) => row.live === 999)).toBe(false);
    expect(rows.map((row) => row.t)).toEqual([30, 60, 90]);
  });

  it('adds the current forecast line only after now', () => {
    const rows = buildForecastChartData(
      fixtureMetric,
      undefined,
      {
        issuedAt: '2026-05-28T00:45:00+10:00',
        intervals: fixtureMetric.intervals,
        poe50: [101, 121, 141],
      },
      Date.parse('2026-05-28T01:00:00+10:00'),
    );

    expect(rows.find((row) => row.t === 60)?.forecastLine).toBeNull();
    expect(rows.find((row) => row.t === 90)?.forecastLine).toBe(141);
  });
});

describe('yScale', () => {
  it('includes live and current forecast values in the rendered domain', () => {
    const scale = yScale(
      fixtureMetric,
      [{ ts: '2026-05-28T00:45:00+10:00', value: 200 }],
      {
        issuedAt: null,
        intervals: fixtureMetric.intervals,
        poe50: [50, 175, null],
      },
    );

    expect(scale.domain[0]).toBeLessThanOrEqual(50);
    expect(scale.domain[1]).toBeGreaterThanOrEqual(200);
  });
});

describe('syncByNearestValue', () => {
  it('chooses the nearest x-axis value', () => {
    expect(
      syncByNearestValue([{ value: 30 }, { value: 60 }, { value: 90 }], { activeLabel: 64 }),
    ).toBe(1);
  });
});
