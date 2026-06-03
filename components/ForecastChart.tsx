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
import type { LiveForecastSeries, LivePoint } from '@/lib/live';

interface ForecastChartProps {
  title: string;
  /** Y-axis unit label, e.g. "MW". */
  unit: string;
  metric: Metric;
  /** Live 5-minute actuals to overlay (today only). */
  liveActual?: LivePoint[];
  /** Pre-dispatch forecast trail (today only, most-recent last). */
  forecasts?: LiveForecastSeries[];
  /** Render the LIVE/STALE badge (today only). */
  live?: boolean;
  stale?: boolean;
  /** Epoch ms of the last fresh live fetch, for the badge text. */
  lastUpdated?: number | null;
}

interface ChartPoint {
  /** Minutes since the trading day's 00:00 AEST (interval-ending; 30 … 1440). */
  t: number;
  /** "HH:MM" label for the tooltip. */
  time: string;
  /** Range [poe90 (low), poe10 (high)] for the static day-ahead shaded band. */
  band: [number, number] | null;
  poe50: number | null;
  actual: number | null;
  /** Live 5-minute actual (today only). */
  live: number | null;
  /** POE50 for each older (trail) forecast, null before its issuedAt. Index 0 = oldest. */
  fcTrail: (number | null)[];
  /** [poe90 (low), poe10 (high)] for the most recent forecast; null before its issuedAt. */
  fcLatestBand: [number, number] | null;
  /** POE50 for the most recent forecast; null before its issuedAt. */
  fcLatestPoe50: number | null;
}

const PAD2 = (n: number) => String(n).padStart(2, '0');

/** Minutes → "HH:MM" interval-ending label (1440 → "00:00"). */
function minuteLabel(t: number): string {
  return `${PAD2(Math.floor(t / 60) % 24)}:${PAD2(t % 60)}`;
}

type FcAnchor = { t: number; p10: number; p50: number; p90: number };

function buildFcAnchors(fc: LiveForecastSeries, dayStartMs: number): FcAnchor[] {
  return fc.intervals
    .map((iso, i) => ({
      t: Math.round((Date.parse(iso) - dayStartMs) / 60_000),
      p10: fc.poe10[i] ?? 0,
      p50: fc.poe50[i] ?? 0,
      p90: fc.poe90[i] ?? 0,
    }))
    .filter((_, i) => fc.poe50[i] != null)
    .sort((a, b) => a.t - b.t);
}

function interpolateAt(anchors: FcAnchor[], t: number): { p10: number; p50: number; p90: number } | null {
  if (!anchors.length) return null;
  let ai = 0;
  while (ai < anchors.length - 1 && anchors[ai + 1].t <= t) ai++;
  const left = anchors[ai];
  const right = ai + 1 < anchors.length ? anchors[ai + 1] : null;
  if (t === left.t || !right) return { p10: left.p10, p50: left.p50, p90: left.p90 };
  const f = (t - left.t) / (right.t - left.t);
  return {
    p10: left.p10 + (right.p10 - left.p10) * f,
    p50: left.p50 + (right.p50 - left.p50) * f,
    p90: left.p90 + (right.p90 - left.p90) * f,
  };
}

/**
 * Merge the half-hourly forecast plume, 5-minute live actuals, and NEMWEB
 * pre-dispatch forecasts onto a single numeric (minutes-of-day) axis.
 */
function buildData(metric: Metric, liveActual?: LivePoint[], forecasts?: LiveForecastSeries[]): ChartPoint[] {
  const dayStartMs = Date.parse(metric.intervals[0]) - 30 * 60_000;
  const minutesOf = (iso: string) => Math.round((Date.parse(iso) - dayStartMs) / 60_000);

  const byT = new Map<number, ChartPoint>();
  const row = (t: number): ChartPoint => {
    let r = byT.get(t);
    if (!r) {
      r = { t, time: minuteLabel(t), band: null, poe50: null, actual: null, live: null,
             fcTrail: [], fcLatestBand: null, fcLatestPoe50: null };
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

  const rows = [...byT.values()].sort((a, b) => a.t - b.t);

  // Interpolate the static plume onto live-only rows (5-min points between 30-min marks).
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

  // NEMWEB pre-dispatch forecast trail.
  if (forecasts?.length) {
    const n = forecasts.length;
    const fcAnchors = forecasts.map((fc) => buildFcAnchors(fc, dayStartMs));
    const issuedTs = forecasts.map((fc) => minutesOf(fc.issuedAt));

    for (const r of rows) r.fcTrail = new Array(n - 1).fill(null);

    for (let fi = 0; fi < n; fi++) {
      const anch = fcAnchors[fi];
      if (!anch.length) continue;
      const issuedT = issuedTs[fi];
      const isLatest = fi === n - 1;

      for (const r of rows) {
        if (r.t < issuedT) continue;
        const val = interpolateAt(anch, r.t);
        if (!val) continue;
        if (isLatest) {
          r.fcLatestBand = [val.p90, val.p10];
          r.fcLatestPoe50 = val.p50;
        } else {
          r.fcTrail[fi] = val.p50;
        }
      }
    }
  }

  return rows;
}

const BAND_COLOR = '#c4b59a';
const POE50_COLOR = '#3a3833';
const ACTUAL_COLOR = '#c0552d';
const GRID_COLOR = '#e3ddd0';
const TRAIL_COLOR = '#7a7570';

/** Opacity for each trail position (oldest → second-newest, up to 5). */
const TRAIL_OPACITIES = [0.1, 0.18, 0.28, 0.4, 0.55];

const AXIS_TICK = {
  fontSize: 11,
  fill: '#6f6a60',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};

const DELTA_ACCENT = '#c0552d';
const DELTA_NEUTRAL = '#6f6a60';
const SYNC_ID = 'nemweb-forecast';

function syncByNearestValue(ticks: any, data: any): number {
  const target = Number(data?.activeLabel);
  if (!Array.isArray(ticks) || ticks.length === 0 || Number.isNaN(target)) {
    return data?.activeTooltipIndex ?? -1;
  }
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const dist = Math.abs(Number(ticks[i]?.value) - target);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

const HOUR_TICKS = [180, 360, 540, 720, 900, 1080, 1260, 1440];
const TOOLTIP_WIDTH = 192;

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

function yScale(
  metric: Metric,
  liveActual?: LivePoint[],
  forecasts?: LiveForecastSeries[],
): { domain: [number, number]; ticks: number[] } {
  const vals: number[] = [];
  for (const arr of [metric.poe10, metric.poe50, metric.poe90, metric.actual]) {
    for (const v of arr) if (v != null) vals.push(v);
  }
  if (liveActual) for (const p of liveActual) if (p.value != null) vals.push(p.value);
  if (forecasts?.length) {
    const latest = forecasts[forecasts.length - 1];
    for (const arr of [latest.poe10, latest.poe50, latest.poe90]) {
      for (const v of arr) if (v != null) vals.push(v);
    }
    for (const fc of forecasts.slice(0, -1)) {
      for (const v of fc.poe50) if (v != null) vals.push(v);
    }
  }
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

/** "2026-06-03T10:30+10:00" → "10:30am" */
function formatIssuedTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d).replace(' ', '').replace(' ', '');
}

interface TooltipPayloadItem {
  payload: ChartPoint;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  unit: string;
  latestFcIssuedAt?: string;
}

function ChartTooltip({ active, payload, unit, latestFcIssuedAt }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const { poe50, actual, live, band, time, fcLatestPoe50 } = point;
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
        <span>{sign}{fmt(diff)} {unit} ({sign}{pct.toFixed(1)}%)</span>
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
      {fcLatestPoe50 != null && latestFcIssuedAt && (
        <div className="tt-row" style={{ color: ACTUAL_COLOR, opacity: 0.8 }}>
          <span>Latest fcst ({formatIssuedTime(latestFcIssuedAt)})</span>
          <span>{fmt(fcLatestPoe50)} {unit}</span>
        </div>
      )}
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
  forecasts,
  live = false,
  stale = false,
  lastUpdated = null,
}: ForecastChartProps) {
  const hasLive = (liveActual?.length ?? 0) > 0;
  const data = buildData(metric, liveActual, forecasts);
  const { domain, ticks } = yScale(metric, liveActual, forecasts);
  const xMin = data.length ? data[0].t : 30;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, [live]);

  const tooltipX = Math.max(8, width - TOOLTIP_WIDTH - 8);

  const trailCount = forecasts ? forecasts.length - 1 : 0;
  const latestFc = forecasts?.length ? forecasts[forecasts.length - 1] : undefined;

  return (
    <div className="chart-card">
      <h3>
        <span className="chart-title">
          {title} <span className="chart-unit">{unit}</span>
        </span>
        {live && (
          <span
            className={`live-badge${stale ? ' stale' : ''}`}
            title="Updated every ~10 min by a scheduled job."
          >
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
              content={<ChartTooltip unit={unit} latestFcIssuedAt={latestFc?.issuedAt} />}
              position={{ x: tooltipX, y: 8 }}
              isAnimationActive={false}
            />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 4 }} iconType="plainline" />

            {/* 1. Static day-ahead plume (back of z-order) */}
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

            {/* 2. Grey trail lines (older forecasts, increasing opacity newest→oldest) */}
            {Array.from({ length: trailCount }, (_, i) => {
              const opacity = TRAIL_OPACITIES[Math.max(0, TRAIL_OPACITIES.length - trailCount + i)];
              return (
                <Line
                  key={`fc-trail-${i}`}
                  type="monotone"
                  dataKey={(d: ChartPoint) => d.fcTrail[i] ?? null}
                  stroke={TRAIL_COLOR}
                  strokeWidth={1}
                  strokeOpacity={opacity}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                  activeDot={false}
                  legendType="none"
                />
              );
            })}

            {/* 3. Most recent forecast: faded band + dashed red POE50 */}
            {latestFc && (
              <Area
                type="monotone"
                dataKey="fcLatestBand"
                stroke="none"
                fill={BAND_COLOR}
                fillOpacity={0.22}
                connectNulls={false}
                isAnimationActive={false}
                activeDot={false}
                legendType="none"
              />
            )}
            {latestFc && (
              <Line
                type="monotone"
                dataKey="fcLatestPoe50"
                name="Latest forecast"
                stroke={ACTUAL_COLOR}
                strokeWidth={1.2}
                strokeDasharray="4 4"
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
                activeDot={false}
              />
            )}

            {/* 4. Live actuals on top */}
            {!live && (
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
            )}
            {live && (
              <Line
                type="monotone"
                dataKey="live"
                name="Actuals (Live)"
                stroke={ACTUAL_COLOR}
                strokeWidth={1.5}
                dot={false}
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
