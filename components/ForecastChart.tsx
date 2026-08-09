'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildForecastChartData,
  syncByNearestValue,
  yScale,
  type ChartPoint,
  type CurrentForecastProp,
} from '@/lib/chartData';
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
  /** Current NEMWEB POE50 forecast for the rest of today (today only). */
  currentForecast?: CurrentForecastProp;
  /**
   * True for half-hourly (rooftop) actuals — renders small dots on each point
   * so sparse data is visible even when only a few intervals have reported.
   */
  sparseActuals?: boolean;
}

const PAD2 = (n: number) => String(n).padStart(2, '0');

/** Extract "HH:MM" from an AEST ISO string like "2026-06-03T13:00:00+10:00". */
function issuedHHMM(iso: string | null): string {
  if (!iso) return '—';
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '—';
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

/** X-axis ticks every 3 hours, as minutes-of-day (03:00 … 24:00). */
const HOUR_TICKS = [180, 360, 540, 720, 900, 1080, 1260, 1440];

const TOOLTIP_WIDTH = 176;

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

/** Tooltip: time, POE50, Actual (live or settled), Δ vs forecast, and current forecast. */
function ChartTooltip({ active, payload, unit }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const { poe50, actual, live, band, time, forecastLine, forecastIssuedAt } = point;
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
      {forecastLine != null && (
        <div className="tt-row" style={{ color: ACTUAL_COLOR }}>
          <span>Latest forecast</span>
          <span>
            {fmt(forecastLine)} {unit}
            {forecastIssuedAt && ` (${issuedHHMM(forecastIssuedAt)})`}
          </span>
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
  live = false,
  stale = false,
  lastUpdated = null,
  currentForecast,
  sparseActuals = false,
}: ForecastChartProps) {
  const hasLive = (liveActual?.length ?? 0) > 0;
  const hasForecastLine = !!currentForecast && live;

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

  // Keep the badge text and "Now" marker current.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 30 * 1000);
    return () => clearInterval(id);
  }, [live]);

  const data = buildForecastChartData(
    metric,
    liveActual,
    hasForecastLine ? currentForecast : undefined,
    live ? now : undefined,
  );
  const { domain, ticks } = yScale(metric, liveActual, hasForecastLine ? currentForecast : undefined);
  const xMin = data.length ? data[0].t : 30;
  const tooltipX = Math.max(8, width - TOOLTIP_WIDTH - 8);

  // "Now" marker position in minutes-of-day (AEST, matching the x-axis).
  const dayStartMs =
    metric.intervals.length > 0 ? Date.parse(metric.intervals[0]) - 30 * 60_000 : 0;
  const nowMinutes = Math.round((now - dayStartMs) / 60_000);

  return (
    <div className="chart-card" role="region" aria-label={`${title} forecast chart`}>
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
      {data.length === 0 && <p className="status">No chart data available.</p>}
      <div className="chart-body" ref={bodyRef}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            syncId={SYNC_ID}
            syncMethod={syncByNearestValue}
            margin={{ top: 20, right: 16, bottom: 8, left: 8 }}
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

            {/* "Now" vertical marker — divides actuals from forecast. */}
            {live && nowMinutes >= xMin && nowMinutes <= 1440 && (
              <ReferenceLine
                x={nowMinutes}
                stroke="#c0b8ad"
                strokeWidth={1}
                strokeDasharray="2 3"
                label={{
                  value: 'Now',
                  position: 'top',
                  fill: '#b0a898',
                  fontSize: 10,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                }}
              />
            )}

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
            {/* Settled half-hourly actuals (historical days). */}
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
                strokeWidth={2}
                dot={sparseActuals ? { r: 3, fill: ACTUAL_COLOR, strokeWidth: 0 } : false}
                activeDot={{ r: 4, fill: ACTUAL_COLOR, strokeWidth: 0 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
            {/* Current NEMWEB forecast — dashed, future intervals only. */}
            {hasForecastLine && (
              <Line
                type="monotone"
                dataKey="forecastLine"
                name="Latest forecast (POE50)"
                stroke={ACTUAL_COLOR}
                strokeWidth={1.5}
                strokeDasharray="6 4"
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
