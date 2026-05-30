/**
 * CSV export for the currently displayed day + region.
 *
 * Emits one row per half-hour interval with both demand and rooftop PV series:
 * POE10/50/90, actual, and delta (actual - POE50) for each. Missing values are
 * left blank. Mirrors the on-screen "Δ vs forecast" tooltip convention.
 */
import type { Metric, RegionData } from '@/lib/data';

/** Blank for nulls; plain number otherwise (no thousands separators for CSV). */
function cell(v: number | null | undefined): string {
  return v == null ? '' : String(v);
}

/** Delta = actual - POE50, or null if either is missing. */
function delta(m: Metric, i: number): number | null {
  const a = m.actual[i];
  const f = m.poe50[i];
  if (a == null || f == null) return null;
  return Math.round((a - f) * 100) / 100;
}

const HEADER = [
  'interval',
  'demand_poe10',
  'demand_poe50',
  'demand_poe90',
  'demand_actual',
  'demand_delta',
  'rooftopPv_poe10',
  'rooftopPv_poe50',
  'rooftopPv_poe90',
  'rooftopPv_actual',
  'rooftopPv_delta',
];

export function regionDataToCsv(data: RegionData): string {
  const { demand, rooftopPv } = data;
  const rows: string[] = [HEADER.join(',')];
  for (let i = 0; i < demand.intervals.length; i++) {
    rows.push(
      [
        demand.intervals[i],
        cell(demand.poe10[i]),
        cell(demand.poe50[i]),
        cell(demand.poe90[i]),
        cell(demand.actual[i]),
        cell(delta(demand, i)),
        cell(rooftopPv.poe10[i]),
        cell(rooftopPv.poe50[i]),
        cell(rooftopPv.poe90[i]),
        cell(rooftopPv.actual[i]),
        cell(delta(rooftopPv, i)),
      ].join(','),
    );
  }
  return rows.join('\n');
}

/** Trigger a client-side download of `content` as `filename`. */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
