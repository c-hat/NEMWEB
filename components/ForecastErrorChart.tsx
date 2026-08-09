'use client';

import {
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
  buildForecastErrorData,
  forecastErrorYScale,
  type ForecastErrorPoint,
} from '@/lib/forecastErrorData';
import { REGION_LABELS, type Region, type RegionData, type SelectableRegion } from '@/lib/data';
import type { LiveRegion } from '@/lib/live';
import { syncByNearestValue } from '@/lib/chartData';

interface ForecastErrorChartProps {
  regions: Record<Region, RegionData>;
  region: SelectableRegion;
  liveRegions?: Record<string, LiveRegion>;
}

const SYNC_ID = 'nemweb-forecast';
const HOUR_TICKS = [180, 360, 540, 720, 900, 1080, 1260, 1440];
const GRID_COLOR = '#e3ddd0';
const DEMAND_ERROR_COLOR = '#6fa29a';
const ROOFTOP_COLOR = '#d07a2d';

const AXIS_TICK = {
  fontSize: 11,
  fill: '#6f6a60',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};

function fmt(v: number): string {
  return Math.round(v).toLocaleString('en-AU');
}

function fmtPct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

interface TooltipPayloadItem {
  payload: ForecastErrorPoint;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}

function ChartTooltip({ active, payload }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;

  return (
    <div className="chart-tooltip forecast-error-tooltip">
      <div className="tt-time">{point.time}</div>
      <div className="tt-row">
        <span>Demand error</span>
        <span>{fmt(point.demandError)} MW</span>
      </div>
      <div className="tt-row">
        <span>Rooftop PV error</span>
        <span>{fmt(point.rooftopContribution)} MW</span>
      </div>
      <div className="tt-row">
        <span>Rooftop explained</span>
        <span>{fmtPct(point.rooftopExplainedPct)}</span>
      </div>
    </div>
  );
}

export default function ForecastErrorChart({
  regions,
  region,
  liveRegions,
}: ForecastErrorChartProps) {
  const { points } = buildForecastErrorData({ regions, region, liveRegions });
  const { domain, ticks } = forecastErrorYScale(points);

  return (
    <div
      className="chart-card forecast-error-card"
      role="region"
      aria-label={`${REGION_LABELS[region]} forecast error decomposition chart`}
    >
      <h3>
        <span className="chart-title">
          {REGION_LABELS[region]} — Forecast Error <span className="chart-unit">MW</span>
        </span>
      </h3>

      {points.length === 0 && <p className="status">No chart data available.</p>}
      <div className="chart-body">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            syncId={SYNC_ID}
            syncMethod={syncByNearestValue}
            margin={{ top: 20, right: 16, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="1 4" stroke={GRID_COLOR} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={[30, 1440]}
              ticks={HOUR_TICKS}
              interval={0}
              tickFormatter={(t: number) => String(Math.round(t / 60) % 24).padStart(2, '0')}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: GRID_COLOR }}
              allowDecimals={false}
            />
            <YAxis
              domain={domain}
              ticks={ticks}
              label={{
                value: 'Forecast error (MW)',
                angle: -90,
                position: 'insideLeft',
                fill: '#6f6a60',
                fontSize: 11,
              }}
              tickFormatter={(v: number) => v.toLocaleString('en-AU')}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={58}
              allowDecimals={false}
            />
            <Tooltip content={<ChartTooltip />} isAnimationActive={false} />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 4 }} iconType="plainline" />
            <ReferenceLine y={0} stroke="#82786a" strokeWidth={1.4} />
            <Line
              type="monotone"
              dataKey="demandError"
              name="Demand error"
              stroke={DEMAND_ERROR_COLOR}
              strokeWidth={1.7}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="rooftopContribution"
              name="Rooftop PV error"
              stroke={ROOFTOP_COLOR}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
