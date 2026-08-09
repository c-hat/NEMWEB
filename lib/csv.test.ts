import { describe, expect, it } from 'vitest';
import { fixtureRegionData } from '@/__fixtures__/dayData';
import { regionDataToCsv } from './csv';

describe('regionDataToCsv', () => {
  it('emits one row per interval with blank cells for missing values', () => {
    const csv = regionDataToCsv(fixtureRegionData);

    expect(csv.split('\n')).toEqual([
      'interval,demand_poe10,demand_poe50,demand_poe90,demand_actual,demand_delta,rooftopPv_poe10,rooftopPv_poe50,rooftopPv_poe90,rooftopPv_actual,rooftopPv_delta',
      '2026-05-28T00:30:00+10:00,120,100,80,95,-5,45,40,35,38,-2',
      '2026-05-28T01:00:00+10:00,140,120,100,,,55,50,45,,',
      '2026-05-28T01:30:00+10:00,160,140,120,150,10,65,60,55,62,2',
    ]);
  });
});
