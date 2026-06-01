'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Metric } from '@/lib/data';
import type { LivePoint } from '@/lib/live';

interface ForecastChartProps {
  title: string;
  /** Y-axis unit label, e.g. "MW". */
  unit: string;
  metric: Metric;
  /** Live 5-minute actuals to overlay (today only). */
  liveActual?: LivePoint[];
  /** Render the LIVE/STALE badge (today only). */
  live?: boolean;
  stale?: boolean;
  /** Epoch ms of the last fresh live fetch, for the badge text. */
  lastUpdated?: number | null;
  /** Draw the live overlay as 30-min step marks rather than a continuous line. */
  liveStep?: boolean;
}

interface ChartPoint {
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
}

const PAD2 = (n: number) => String(n).padStart(2, '0');

/** Minutes → "HH:MM" interval-ending label (1440 → "00:00"). */
function minuteLabel(t: number): string {
  return `${PAD2(Math.floor(t / 60) % 24)}:${PAD2(t % 60)}`;
}

/**
 * Merge the half-hourly forecast plume and any 5-minute live actuals onto a
 * single numeric (minutes-of-day) axis. Forecast intervals land at 30, 60, …,
 * 1440; live points at their 5-minute marks. Overlapping marks carry both.
 */
function buildData(metric: Metric, liveActual?: LivePoint[]): ChartPoint[] {
  const dayStartMs = Date.parse(metric.intervals[0]) - 30 * 60_000;
  const minutesOf = (iso: string) => Math.round((Date.parse(iso) - dayStartMs) / 60_000);

  const byT = new Map<number, ChartPoint>();
  const row = (t: number): ChartPoint => {
    let r = byT.get(t);
    if (!r) {
      r = { t, time: minuteLabel(t), band: null, poe50: null, actual: null, live: null };
      byT.set(t, r);
    }
    return r;
  };

  metric.intervals.forEach((iso, i) => {
    const r = row(minutesOf(iso));
    const low = metric.poe90[i];
    const high = metric.poe10[i];
    r.band = low != null && high != null ? [low, high] : null;
    r.poe50 = metric.poe50[i];
    r.actual = metric.actual[i];
  });

  if (liveActual) {
    for (const p of liveActual) row(minutesOf(p.ts)).live = p.value;
  }

  return [...byT.values()].sort((a, b) => a.t - b.t);
}

const BAND_COLOR = '#c4b59a';
const POE50_COLOR = '#3a3833';
const ACTUAL_COLOR = '#c0552d';
const GRID_COLOR = '#e3ddd0';

/** Small monospace axis ticks, matching the OE-style numeric readouts. */
const AXIS_TICK = {
  fontSize: 11,
  fill: '#6f6a60',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};

/** Delta colour when the actual falls outside the POE10–POE90 band. */
const DELTA_ACCENT = '#c0552d';
const DELTA_NEUTRAL = '#6f6a60';

/** Shared id so hovering one chart syncs the crosshair/tooltip on the other. */
const SYNC_ID = 'nemweb-forecast';

/**
 * Sync tooltips across charts by nearest x-value (minutes), not array index.
 * The demand (5-min) and rooftop (30-min) charts have different point
 * densities, so index-based sync would point at the wrong time; matching on the
 * `t` value keeps the crosshair on the same moment in both charts.
 */
function syncByNearestValue(ticks: any, data: any): number {
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

/** X-axis ticks every 3 hours, as minutes-of-day (03:00 … 24:00). */
const HOUR_TICKS = [180, 360, 540, 720, 900, 1080, 1260, 1440];

const TOOLTIP_WIDTH = 176;

/** Round a range to a "nice" 1/2/5 × 10ⁿ value (Heckbert's algorithm). */
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
 * Dynamic y-scale snapped to round numbers: [min - pad, max + pad] (pad = 5%
 * of range) is widened to nice round bounds with evenly spaced round ticks.
 * Series at or above zero never produce negative ticks (e.g. rooftop overnight).
 * Live actuals are included so the scale fits them too.
 */
function yScale(metric: Metric, liveActual?: LivePoint[]): { domain: [number, number]; ticks: number[] } {
  const vals: number[] = [];
  for (const arr of [metric.poe10, metric.poe50, metric.poe90, metric.actual]) {
    for (const v of arr) if (v != null) vals.push(v);
  }
  if (liveActual) for (const p of liveActual) if (p.value != null) vals.push(p.value);
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

function fmt(v: number): string {
  return Math.round(v).toLocaleString('en-AU');
}

interface TooltipPayloadItem {
  payload: ChartPoint;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  unit: string;
}

/** Tooltip: time, POE50, Actual (live or settled), and Δ vs forecast. */
function ChartTooltip({ active, payload, unit }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const { poe50, actual, live, band, time } = point;
  const act = actual ?? live;
  const isLive = actual == null && live != null;

  let delta: React.ReactNode = null;
  if (poe50 != null && act != null) {
    const diff = act - poe50;
    const pct = poe50 !== 0 ? (diff / poe50) * 100 : 0;
    const outside = band ? act > band[1] || act < band[0] : false;
    const sign = diff >= 0 ? '+' : '';
    delta = (
      <div className="tt-row" style={{ color: outside ? DELTA_ACCENT : DELTA_NEUTRAL }}>
        <span>Δ vs forecast</span>
        <span>
          {sign}
          {fmt(diff)} {unit} ({sign}
          {pct.toFixed(1)}%)
        </span>
      </div>
    );
  }

  return (
    <div className="chart-tooltip">
      <div className="tt-time">{time}</div>
      <div className="tt-row">
        <span>POE50</span>
        <span>{poe50 == null ? '—' : `${fmt(poe50)} ${unit}`}</span>
      </div>
      {act != null && (
        <div className="tt-row">
          <span>{isLive ? 'Actual (live)' : 'Actual'}</span>
          <span>{`${fmt(act)} ${unit}`}</span>
        </div>
      )}
      {delta}
    </div>
  );
}

function agoText(lastUpdated: number | null | undefined, now: number): string {
  if (lastUpdated == null) return 'connecting…';
  const mins = Math.floor((now - lastUpdated) / 60_000);
  if (mins <= 0) return 'just now';
  return `${mins} min ago`;
}

export default function ForecastChart({
  title,
  unit,
  metric,
  liveActual,
  live = false,
  stale = false,
  lastUpdated = null,
  liveStep = false,
}: ForecastChartProps) {
  const hasLive = (liveActual?.length ?? 0) > 0;
  const data = buildData(metric, liveActual);
  const { domain, ticks } = yScale(metric, liveActual);
  const xMin = data.length ? data[0].t : 30;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Track the plot width so the tooltip can anchor to the top-right corner.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the "updated N min ago" badge text current.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, [live]);

  const tooltipX = Math.max(8, width - TOOLTIP_WIDTH - 8);

  return (
    <div className="chart-card">
      <h3>
        <span className="chart-title">
          {title} <span className="chart-unit">{unit}</span>
        </span>
        {live && (
          <span className={`live-badge${stale ? ' stale' : ''}`}>
            <span className="live-dot" />
            {stale
              ? `Stale · last update ${agoText(lastUpdated, now)}`
              : `Live · updated ${agoText(lastUpdated, now)}`}
          </span>
        )}
      </h3>
      <div className="chart-body" ref={bodyRef}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            syncId={SYNC_ID}
            syncMethod={syncByNearestValue}
            margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="1 4" stroke={GRID_COLOR} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={[xMin, 1440]}
              ticks={HOUR_TICKS}
              interval={0}
              tickFormatter={(t: number) => PAD2(Math.round(t / 60) % 24)}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: GRID_COLOR }}
              allowDecimals={false}
            />
            <YAxis
              domain={domain}
              ticks={ticks}
              tickFormatter={(v: number) => v.toLocaleString('en-AU')}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={52}
              allowDecimals={false}
            />
            <Tooltip
              content={<ChartTooltip unit={unit} />}
              position={{ x: tooltipX, y: 8 }}
              isAnimationActive={false}
            />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 4 }} iconType="plainline" />
            <Area
              type="monotone"
              dataKey="band"
              name="POE10–POE90 band"
              stroke="none"
              fill={BAND_COLOR}
              fillOpacity={0.45}
              connectNulls={hasLive}
              isAnimationActive={false}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="poe50"
              name="POE50 (forecast)"
              stroke={POE50_COLOR}
              strokeWidth={1.5}
              dot={false}
              connectNulls={hasLive}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke={ACTUAL_COLOR}
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            {hasLive && (
              <Line
                type={liveStep ? 'stepAfter' : 'monotone'}
                dataKey="live"
                name={liveStep ? 'Live actual (30-min)' : 'Live actual (5-min)'}
                stroke={ACTUAL_COLOR}
                strokeWidth={1.5}
                dot={liveStep ? { r: 1.5, fill: ACTUAL_COLOR } : false}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
