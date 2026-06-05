import type { Metric } from './data';
import type { LivePoint } from './live';

/** Forecast POE50 series for one region/metric, with the issued timestamp. */
export interface CurrentForecastProp {
  issuedAt: string | null;
  intervals: string[];
  poe50: (number | null)[];
}

export interface ChartPoint {
  /** Minutes since the trading day's 00:00 AEST (interval-ending; 30 … 1440). */
  t: number;
  /** "HH:MM" label for the tooltip. */
  time: string;
  /** Range [poe90 (low), poe10 (high)] for the shaded band; null if incomplete. */
  band: [number, number] | null;
  poe50: number | null;
  actual: number | null;
  /** Live 5-minute actual (today only). */
  live: number | null;
  /** Current NEMWEB forecast POE50 (today only, future intervals only). */
  forecastLine: number | null;
  /** ISO issued timestamp carried on forecast points, for the tooltip. */
  forecastIssuedAt: string | null;
}

const PAD2 = (n: number) => String(n).padStart(2, '0');

/** Minutes -> "HH:MM" interval-ending label (1440 -> "00:00"). */
export function minuteLabel(t: number): string {
  return `${PAD2(Math.floor(t / 60) % 24)}:${PAD2(t % 60)}`;
}

/**
 * Merge the half-hourly forecast plume, any 5-minute live actuals, and the
 * current NEMWEB forecast line onto a single numeric (minutes-of-day) axis.
 */
export function buildForecastChartData(
  metric: Metric,
  liveActual?: LivePoint[],
  currentForecast?: CurrentForecastProp,
  nowMs?: number,
): ChartPoint[] {
  if (metric.intervals.length === 0) return [];

  const dayStartMs = Date.parse(metric.intervals[0]) - 30 * 60_000;
  const minutesOf = (iso: string) => Math.round((Date.parse(iso) - dayStartMs) / 60_000);
  const nowMinutes = nowMs != null ? Math.round((nowMs - dayStartMs) / 60_000) : null;

  const byT = new Map<number, ChartPoint>();
  const row = (t: number): ChartPoint => {
    let r = byT.get(t);
    if (!r) {
      r = {
        t,
        time: minuteLabel(t),
        band: null,
        poe50: null,
        actual: null,
        live: null,
        forecastLine: null,
        forecastIssuedAt: null,
      };
      byT.set(t, r);
    }
    return r;
  };

  metric.intervals.forEach((iso, i) => {
    const r = row(minutesOf(iso));
    const low = metric.poe90[i];
    const high = metric.poe10[i];
    r.band = low != null && high != null ? [low, high] : null;
    r.poe50 = metric.poe50[i] ?? null;
    r.actual = metric.actual[i] ?? null;
  });

  // Start the live actuals at 00:30 (drop 00:00-00:25) so they line up with
  // the forecast's first interval and with archive days (00:30 ... 24:00).
  if (liveActual) {
    for (const p of liveActual) {
      const t = minutesOf(p.ts);
      if (t < 30) continue;
      row(t).live = p.value;
    }
  }

  if (currentForecast && nowMinutes != null) {
    for (let i = 0; i < currentForecast.intervals.length; i++) {
      const t = minutesOf(currentForecast.intervals[i]);
      if (t <= nowMinutes) continue;
      const r = row(t);
      r.forecastLine = currentForecast.poe50[i] ?? null;
      r.forecastIssuedAt = currentForecast.issuedAt;
    }
  }

  const rows = [...byT.values()].sort((a, b) => a.t - b.t);

  // Interpolate the forecast plume onto live-only rows so every tooltip carries
  // a POE50 and delta when demand has 5-minute actual points.
  const anchors = rows.filter((r) => r.poe50 != null);
  if (anchors.length >= 2) {
    let j = 0;
    for (const r of rows) {
      if (r.poe50 != null) continue;
      while (j < anchors.length - 1 && anchors[j + 1].t <= r.t) j++;
      const left = anchors[j];
      const right = anchors[j + 1];
      if (!right || r.t < left.t || r.t > right.t || right.t === left.t) continue;
      const f = (r.t - left.t) / (right.t - left.t);
      if (left.poe50 != null && right.poe50 != null) {
        r.poe50 = left.poe50 + (right.poe50 - left.poe50) * f;
      }
      if (left.band && right.band) {
        r.band = [
          left.band[0] + (right.band[0] - left.band[0]) * f,
          left.band[1] + (right.band[1] - left.band[1]) * f,
        ];
      }
    }
  }

  return rows;
}

/** Round a range to a "nice" 1/2/5 x 10^n value (Heckbert's algorithm). */
function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range || 1));
  const frac = (range || 1) / 10 ** exp;
  let nice: number;
  if (round) {
    if (frac < 1.5) nice = 1;
    else if (frac < 3) nice = 2;
    else if (frac < 7) nice = 5;
    else nice = 10;
  } else if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * 10 ** exp;
}

/**
 * Dynamic y-scale snapped to round numbers. Live actuals and forecast values
 * are included so the scale fits all rendered series.
 */
export function yScale(
  metric: Metric,
  liveActual?: LivePoint[],
  currentForecast?: CurrentForecastProp,
): { domain: [number, number]; ticks: number[] } {
  const vals: number[] = [];
  for (const arr of [metric.poe10, metric.poe50, metric.poe90, metric.actual]) {
    for (const v of arr) if (v != null) vals.push(v);
  }
  if (liveActual) for (const p of liveActual) if (p.value != null) vals.push(p.value);
  if (currentForecast) for (const v of currentForecast.poe50) if (v != null) vals.push(v);
  if (vals.length === 0) return { domain: [0, 1], ticks: [0, 1] };

  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.05 || 1;
  let lo = min - pad;
  const hi = max + pad;
  if (min >= 0) lo = Math.max(0, lo);

  const step = niceNum(niceNum(hi - lo, false) / 5, true);
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = niceLo; v <= niceHi + step * 0.5; v += step) ticks.push(Math.round(v));
  return { domain: [niceLo, niceHi], ticks };
}

/**
 * Sync tooltips across charts by nearest x-value (minutes), not array index.
 * The demand (5-min) and rooftop (30-min) charts have different point
 * densities, so index-based sync would point at the wrong time.
 */
export function syncByNearestValue(ticks: any, data: any): number {
  const target = Number(data?.activeLabel);
  if (!Array.isArray(ticks) || ticks.length === 0 || Number.isNaN(target)) {
    return data?.activeTooltipIndex ?? -1;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const dist = Math.abs(Number(ticks[i]?.value) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
