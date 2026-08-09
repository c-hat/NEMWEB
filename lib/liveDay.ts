import { REGIONS, type DayData, type Metric, type RegionData } from './data';
import type { LiveFile, LivePoint } from './live';

const AEST_TZ = 'Australia/Brisbane';

function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function currentAestDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: AEST_TZ }).format(now);
}

export function liveTradingDate(file: LiveFile | null | undefined): string | null {
  if (!file) return null;
  const candidates: LivePoint[] = [];
  const nem = file.regions.NEM;
  if (nem) {
    candidates.push(...nem.demand, ...nem.rooftopPv);
  }
  for (const region of REGIONS) {
    const liveRegion = file.regions[region];
    if (liveRegion) candidates.push(...liveRegion.demand, ...liveRegion.rooftopPv);
  }
  const point = candidates.find((p) => /^\d{4}-\d{2}-\d{2}T/.test(p.ts));
  if (point) return point.ts.slice(0, 10);

  const updatedAt = Date.parse(file.updatedAt);
  if (!Number.isNaN(updatedAt)) return currentAestDate(new Date(updatedAt));
  return null;
}

function intervalGrid(date: string): string[] {
  const nextDate = addDays(date, 1);
  const intervals: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    intervals.push(`${date}T${String(hour).padStart(2, '0')}:30+10:00`);
    intervals.push(
      hour === 23 ? `${nextDate}T00:00+10:00` : `${date}T${String(hour + 1).padStart(2, '0')}:00+10:00`,
    );
  }
  return intervals;
}

function emptyMetric(intervals: string[]): Metric {
  const empty = intervals.map(() => null);
  return {
    intervals,
    poe10: [...empty],
    poe50: [...empty],
    poe90: [...empty],
    actual: [...empty],
  };
}

export function buildLiveOnlyDayData(date: string): DayData {
  const intervals = intervalGrid(date);
  const regions = Object.fromEntries(
    REGIONS.map((region) => [
      region,
      {
        demand: emptyMetric(intervals),
        rooftopPv: emptyMetric(intervals),
      } satisfies RegionData,
    ]),
  ) as DayData['regions'];

  return {
    tradingDate: date,
    forecastIssuedAt: '',
    regions,
  };
}
