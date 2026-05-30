'use client';

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

/** Interval-ending labels shown on the x-axis: every 3 hours, no :30 suffix. */
const HOUR_TICKS = ['03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00', '00:00'];

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

export default function ForecastChart({ title, unit, metric }: ForecastChartProps) {
  const data = buildData(metric);

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <div className="chart-body">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
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
            formatter={(value: unknown, name: string) => {
              if (Array.isArray(value)) {
                const [low, high] = value as [number, number];
                return [`${low} – ${high} ${unit}`, name];
              }
              return [value == null ? '—' : `${value} ${unit}`, name];
            }}
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
