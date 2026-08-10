'use client';

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MeteorologicalRegion } from '@/lib/systemContext';

const AXIS_TICK = {
  fontSize: 11,
  fill: '#6f6a60',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
};
const TICKS = [180, 360, 540, 720, 900, 1080, 1260, 1440];

interface Props {
  data: MeteorologicalRegion;
}

function chartRows(data: MeteorologicalRegion) {
  const first = data.solar.series[0]?.ts ?? data.forecast[0]?.ts;
  if (!first) return [];
  const dayStart = Date.parse(`${first.slice(0, 10)}T00:00:00+10:00`);
  const rows = new Map<number, Record<string, number | string | null>>();
  const row = (ts: string) => {
    const minute = Math.round((Date.parse(ts) - dayStart) / 60_000);
    let value = rows.get(minute);
    if (!value) {
      value = {
        minute,
        time: `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
      };
      rows.set(minute, value);
    }
    return value;
  };
  for (const point of data.solar.series) Object.assign(row(point.ts), point);
  for (const point of data.utilitySolar.series) {
    Object.assign(row(point.ts), { utilitySolarMw: point.value });
  }
  for (const point of data.residualDemand.series) Object.assign(row(point.ts), point);
  for (const point of data.forecast) {
    Object.assign(row(point.ts), {
      forecastTotalSolarMw: point.totalSolarMw,
      forecastResidualDemandMw: point.residualDemandMw,
      forecastOperationalDemandMw: point.operationalDemandMw,
    });
  }
  return [...rows.values()].sort((a, b) => Number(a.minute) - Number(b.minute));
}

function Axis() {
  return (
    <XAxis
      dataKey="minute"
      type="number"
      domain={[0, 1440]}
      ticks={TICKS}
      tickFormatter={(minute: number) => String(Math.floor(minute / 60) % 24).padStart(2, '0')}
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={{ stroke: '#e3ddd0' }}
    />
  );
}

function ValueAxis() {
  return (
    <YAxis
      tickFormatter={(value: number) => Math.round(value).toLocaleString('en-AU')}
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={false}
      width={55}
    />
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip meteorology-tooltip">
      <div className="tt-time">{payload[0]?.payload?.time ?? label}</div>
      {payload
        .filter((item: any) => item.value != null)
        .map((item: any) => (
          <div className="tt-row" key={item.dataKey}>
            <span>{item.name}</span>
            <span>{Math.round(item.value).toLocaleString('en-AU')} MW</span>
          </div>
        ))}
    </div>
  );
}

export default function SolarResidualCharts({ data }: Props) {
  const rows = chartRows(data);
  return (
    <div className="meteorology-charts">
      <section className="meteorology-chart" aria-label="Solar generation components chart">
        <h3>Solar generation</h3>
        <p className="definition-note">Rooftop estimates end at their native observation time; utility-scale SCADA continues independently. The dashed line is the combined forecast.</p>
        <div className="meteorology-chart-body">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 10, right: 14, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="1 4" stroke="#e3ddd0" vertical={false} />
              <Axis />
              <ValueAxis />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line name="Total solar estimate" dataKey="totalSolarMw" stroke="#c0552d" strokeWidth={2.2} dot={false} connectNulls isAnimationActive={false} />
              <Line name="Rooftop PV" dataKey="rooftopPvMw" stroke="#d29d42" strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
              <Line name="Utility solar" dataKey="utilitySolarMw" stroke="#4b6f73" strokeWidth={1.3} dot={false} isAnimationActive={false} />
              <Line name="Total solar forecast" dataKey="forecastTotalSolarMw" stroke="#c0552d" strokeDasharray="5 4" strokeWidth={1.6} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="meteorology-chart" aria-label="Residual demand chart">
        <h3>Residual demand</h3>
        <p className="definition-note">Operational demand less utility-scale solar—the grid requirement remaining for other sources.</p>
        <div className="meteorology-chart-body">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 10, right: 14, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="1 4" stroke="#e3ddd0" vertical={false} />
              <Axis />
              <ValueAxis />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line name="Residual demand" dataKey="residualDemandMw" stroke="#c0552d" strokeWidth={2.2} dot={false} isAnimationActive={false} />
              <Line name="Operational demand" dataKey="operationalDemandMw" stroke="#9b9488" strokeWidth={1.2} dot={false} isAnimationActive={false} />
              <Line name="Residual demand forecast" dataKey="forecastResidualDemandMw" stroke="#c0552d" strokeDasharray="5 4" strokeWidth={1.6} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
