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

interface ForecastChartProps {
  title: string;
  /** Y-axis unit label, e.g. "MW". */
  unit: string;
  metric: Metric;
}

interface ChartPoint {
  time: string;
  /** Range [poe90 (low), poe10 (high)] for the shaded band; null if incomplete. */
  band: [number, number] | null;
  poe50: number | null;
  actual: number | null;
}

/** "2026-05-28T00:30+10:00" -> "00:30". Falls back to the raw string. */
function timeLabel(iso: string): string {
  const match = iso.match(/T(\d{2}:\d{2})/);
  return match ? match[1] : iso;
}

function buildData(metric: Metric): ChartPoint[] {
  return metric.intervals.map((iso, i) => {
    const low = metric.poe90[i];
    const high = metric.poe10[i];
    return {
      time: timeLabel(iso),
      band: low != null && high != null ? [low, high] : null,
      poe50: metric.poe50[i],
      actual: metric.actual[i],
    };
  });
}

const BAND_COLOR = '#60a5fa';
const POE50_COLOR = '#1d4ed8';
const ACTUAL_COLOR = '#dc2626';

/** Delta colour when the actual falls outside the POE10–POE90 band. */
const DELTA_ACCENT = '#dc2626';
const DELTA_NEUTRAL = '#64748b';

/** Shared id so hovering one chart syncs the crosshair/tooltip on the other. */
const SYNC_ID = 'nemweb-forecast';

/** Interval-ending labels shown on the x-axis: every 3 hours, no :30 suffix. */
const HOUR_TICKS = ['03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '00:00'];

const TOOLTIP_WIDTH = 176;

/** Dynamic y-domain: [min - pad, max + pad] with pad = 5% of (max - min). */
function yDomain(metric: Metric): [number, number] {
  const vals: number[] = [];
  for (const arr of [metric.poe10, metric.poe50, metric.poe90, metric.actual]) {
    for (const v of arr) if (v != null) vals.push(v);
  }
  if (vals.length === 0) return [0, 1];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.05 || 1;
  return [min - pad, max + pad];
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

/** Three/four-row tooltip: time, POE50, Actual, and Δ vs forecast. */
function ChartTooltip({ active, payload, unit }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const { poe50, actual, band, time } = point;

  let delta: React.ReactNode = null;
  if (poe50 != null && actual != null) {
    const diff = actual - poe50;
    const pct = poe50 !== 0 ? (diff / poe50) * 100 : 0;
    const outside = band ? actual > band[1] || actual < band[0] : false;
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
      <div className="tt-row">
        <span>Actual</span>
        <span>{actual == null ? '—' : `${fmt(actual)} ${unit}`}</span>
      </div>
      {delta}
    </div>
  );
}

export default function ForecastChart({ title, unit, metric }: ForecastChartProps) {
  const data = buildData(metric);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Track the plot width so the tooltip can anchor to the top-right corner.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tooltipX = Math.max(8, width - TOOLTIP_WIDTH - 8);

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <div className="chart-body" ref={bodyRef}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            syncId={SYNC_ID}
            margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="time"
              ticks={HOUR_TICKS}
              interval={0}
              tickFormatter={(v: string) => v.slice(0, 2)}
              tick={{ fontSize: 12 }}
              minTickGap={16}
            />
            <YAxis
              domain={yDomain(metric)}
              tick={{ fontSize: 12 }}
              width={56}
              allowDecimals={false}
              label={{ value: unit, angle: -90, position: 'insideLeft', style: { fontSize: 12 } }}
            />
            <Tooltip
              content={<ChartTooltip unit={unit} />}
              position={{ x: tooltipX, y: 8 }}
              isAnimationActive={false}
            />
            <Legend />
            <Area
              type="monotone"
              dataKey="band"
              name="POE10–POE90 band"
              stroke="none"
              fill={BAND_COLOR}
              fillOpacity={0.25}
              connectNulls={false}
              isAnimationActive={false}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="poe50"
              name="POE50 (forecast)"
              stroke={POE50_COLOR}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="actual"
              name="Actual"
              stroke={ACTUAL_COLOR}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
