import { buildNemRegion, REGIONS, type Region, type RegionData, type SelectableRegion } from './data';
import type { LivePoint, LiveRegion } from './live';

export interface ForecastErrorPoint {
  /** Minutes since trading-day 00:00 AEST, using interval-ending timestamps. */
  t: number;
  time: string;
  interval: string;
  /** actual demand - day-ahead POE50 demand forecast. */
  demandError: number;
  /** Negative rooftop error: forecast rooftop - actual rooftop. */
  rooftopContribution: number;
  /** Demand error not explained by rooftop forecast miss. */
  residual: number;
  /** Interval-level rooftop-explained percentage, null when demand error is zero. */
  rooftopExplainedPct: number | null;
}

export interface ForecastErrorResult {
  points: ForecastErrorPoint[];
}

interface BuildForecastErrorOptions {
  regions: Record<Region, RegionData>;
  region: SelectableRegion;
  /** Live actuals for today, keyed by region. Historical days use settled actual arrays. */
  liveRegions?: Record<string, LiveRegion>;
}

const PAD2 = (n: number) => String(n).padStart(2, '0');

function minuteLabel(t: number): string {
  return `${PAD2(Math.floor(t / 60) % 24)}:${PAD2(t % 60)}`;
}

function minutesSinceStart(dayStartMs: number, iso: string): number {
  return Math.round((Date.parse(iso) - dayStartMs) / 60_000);
}

function latestLiveValueAtOrBefore(points: LivePoint[] | undefined, intervalMs: number): number | null {
  if (!points || points.length === 0) return null;
  let bestTs = -Infinity;
  let bestValue: number | null = null;
  const windowStartMs = intervalMs - 30 * 60_000;
  for (const point of points) {
    const ts = Date.parse(point.ts);
    if (Number.isNaN(ts) || ts < windowStartMs || ts > intervalMs || ts < bestTs) continue;
    bestTs = ts;
    bestValue = point.value;
  }
  return bestTs === -Infinity ? null : bestValue;
}

function exactLiveValueAt(points: LivePoint[] | undefined, intervalMs: number): number | null {
  if (!points || points.length === 0) return null;
  for (const point of points) {
    if (Date.parse(point.ts) === intervalMs) return point.value;
  }
  return null;
}

function liveRegionValueForInterval(
  liveRegions: Record<string, LiveRegion> | undefined,
  region: SelectableRegion,
  metric: keyof LiveRegion,
  intervalMs: number,
): number | null {
  if (!liveRegions) return null;
  const valueAt =
    metric === 'rooftopPv'
      ? exactLiveValueAt
      : latestLiveValueAtOrBefore;
  if (region !== 'NEM') return valueAt(liveRegions[region]?.[metric], intervalMs);

  let total = 0;
  for (const code of REGIONS) {
    const value = valueAt(liveRegions[code]?.[metric], intervalMs);
    if (value == null) return null;
    total += value;
  }
  return total;
}

function actualAt(
  metricActual: (number | null)[],
  index: number,
  intervalIso: string,
  liveRegions: Record<string, LiveRegion> | undefined,
  region: SelectableRegion,
  liveMetric: keyof LiveRegion,
): number | null {
  if (!liveRegions) return metricActual[index] ?? null;
  return liveRegionValueForInterval(liveRegions, region, liveMetric, Date.parse(intervalIso));
}

function intervalExplainedPct(demandError: number, residual: number): number | null {
  const denom = Math.abs(demandError);
  if (denom === 0) return null;
  return Math.max(0, 1 - Math.abs(residual) / denom) * 100;
}

export function buildForecastErrorData({
  regions,
  region,
  liveRegions,
}: BuildForecastErrorOptions): ForecastErrorResult {
  const regionData = region === 'NEM' ? buildNemRegion(regions) : regions[region];
  if (!regionData) return { points: [] };

  const intervals = regionData.demand.intervals;
  if (intervals.length === 0) return { points: [] };

  const dayStartMs = Date.parse(intervals[0]) - 30 * 60_000;
  const points: ForecastErrorPoint[] = [];

  for (let i = 0; i < intervals.length; i++) {
    const interval = intervals[i];
    const forecastDemand = regionData.demand.poe50[i] ?? null;
    const forecastRooftop = regionData.rooftopPv.poe50[i] ?? null;
    const actualDemand = actualAt(
      regionData.demand.actual,
      i,
      interval,
      liveRegions,
      region,
      'demand',
    );
    const actualRooftop = actualAt(
      regionData.rooftopPv.actual,
      i,
      interval,
      liveRegions,
      region,
      'rooftopPv',
    );

    if (
      forecastDemand == null ||
      forecastRooftop == null ||
      actualDemand == null ||
      actualRooftop == null
    ) {
      continue;
    }

    const demandError = actualDemand - forecastDemand;
    const rooftopContribution = -(actualRooftop - forecastRooftop);
    const residual = demandError - rooftopContribution;
    const t = minutesSinceStart(dayStartMs, interval);

    points.push({
      t,
      time: minuteLabel(t),
      interval,
      demandError,
      rooftopContribution,
      residual,
      rooftopExplainedPct: intervalExplainedPct(demandError, residual),
    });
  }

  return { points };
}

/** Symmetric forecast-error y-scale around zero, with round ticks. */
export function forecastErrorYScale(points: ForecastErrorPoint[]): {
  domain: [number, number];
  ticks: number[];
} {
  const values = [0];
  for (const point of points) {
    values.push(point.demandError, point.rooftopContribution);
  }

  const maxAbs = Math.max(...values.map((value) => Math.abs(value)));
  if (maxAbs === 0) return { domain: [-1, 1], ticks: [-1, 0, 1] };

  const rawStep = maxAbs / 3;
  const exp = Math.floor(Math.log10(rawStep || 1));
  const frac = rawStep / 10 ** exp;
  const step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * 10 ** exp;
  const bound = Math.ceil(maxAbs / step) * step;
  const ticks: number[] = [];
  for (let value = -bound; value <= bound + step * 0.5; value += step) {
    ticks.push(Math.round(value));
  }
  return { domain: [-bound, bound], ticks };
}
