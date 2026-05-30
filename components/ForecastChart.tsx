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

export default function ForecastChart({ title, unit, metric }: ForecastChartProps) {
  const data = buildData(metric);

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis
            dataKey="time"
            interval={5}
            tick={{ fontSize: 12 }}
            minTickGap={16}
          />
          <YAxis
            tick={{ fontSize: 12 }}
            width={56}
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
  );
}
