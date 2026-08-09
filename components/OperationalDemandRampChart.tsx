'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { buildDemandRamps } from '@/lib/systemContext';
import type { ForecastSeries, LivePoint } from '@/lib/live';

const AXIS_TICK = {
  fontSize: 11,
  fill: '#6f6a60',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};

interface Props {
  actual: LivePoint[];
  forecast?: ForecastSeries;
}

export default function OperationalDemandRampChart({ actual, forecast }: Props) {
  const data = buildDemandRamps(actual, forecast);
  return (
    <div className="ramp-chart" role="region" aria-label="Thirty-minute operational demand ramp chart">
      <div className="ramp-chart-heading">
        <h3>Operational demand ramp</h3>
        <span>30-minute change · MW</span>
      </div>
      <p className="definition-note">
        Grid-supplied demand, already net of rooftop PV. Positive values are upward ramps.
      </p>
      <div className="ramp-chart-body">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
            <CartesianGrid strokeDasharray="1 4" stroke="#e3ddd0" vertical={false} />
            <XAxis
              dataKey="minute"
              type="number"
              domain={[0, 1440]}
              ticks={[180, 360, 540, 720, 900, 1080, 1260, 1440]}
              tickFormatter={(minute: number) => String(Math.floor(minute / 60) % 24).padStart(2, '0')}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={{ stroke: '#e3ddd0' }}
            />
            <YAxis
              tickFormatter={(value: number) => Math.round(value).toLocaleString('en-AU')}
              tick={AXIS_TICK}
              tickLine={false}
              axisLine={false}
              width={52}
            />
            <ReferenceLine y={0} stroke="#9b9488" />
            <Tooltip
              labelFormatter={(_, payload) => payload?.[0]?.payload?.time ?? ''}
              formatter={(value: number, name: string) => [
                `${Math.round(value).toLocaleString('en-AU')} MW`,
                name === 'observedRampMw' ? 'Observed' : 'Latest forecast',
              ]}
              contentStyle={{ fontSize: 12, borderColor: '#e3ddd0', background: '#fcfbf8' }}
            />
            <Legend
              formatter={(value) => (value === 'observedRampMw' ? 'Observed' : 'Latest forecast')}
              wrapperStyle={{ fontSize: 12 }}
            />
            <Line
              type="monotone"
              dataKey="observedRampMw"
              stroke="#c0552d"
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="forecastRampMw"
              stroke="#3a3833"
              strokeWidth={1.5}
              strokeDasharray="5 4"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
