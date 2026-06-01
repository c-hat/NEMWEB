/**
 * Client-side data access for the NEMWEB forecast tracker.
 *
 * Data is fetched at runtime from the static `public/data/` directory so newly
 * ingested days appear without rebuilding the app. All paths are prefixed with
 * the configured base path to stay GitHub-Pages-subpath friendly.
 */

export const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'] as const;
export type Region = (typeof REGIONS)[number];

/** Regions offered in the UI: the NEM-wide aggregate plus the five AEMO regions. */
export const SELECTABLE_REGIONS = ['NEM', 'NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'] as const;
export type SelectableRegion = (typeof SELECTABLE_REGIONS)[number];

/** Display labels for the UI. Internal AEMO codes (NSW1 …) stay in the data layer. */
export const REGION_LABELS: Record<string, string> = {
  NEM: 'NEM',
  NSW1: 'NSW',
  VIC1: 'VIC',
  QLD1: 'QLD',
  SA1: 'SA',
  TAS1: 'TAS',
};

/**
 * Format a forecast-issued ISO timestamp (always +10:00 AEST) as a readable
 * label, e.g. "2026-05-27T17:00+10:00" -> "5:00pm AEST, Wed 27 May 2026".
 */
export function formatIssued(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Brisbane',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const ampm = (p.dayPeriod || '').toLowerCase().replace(/\s|\./g, '');
  return `${p.hour}:${p.minute}${ampm} AEST, ${p.weekday} ${p.day} ${p.month} ${p.year}`;
}

/** A forecast/actual series. Missing values are null. 48 half-hour intervals. */
export interface Metric {
  /** ISO timestamps for each half-hour-ending interval (00:30 … 24:00 AEST). */
  intervals: string[];
  /** High POE band (poe10 >= poe50 >= poe90). */
  poe10: (number | null)[];
  poe50: (number | null)[];
  /** Low POE band. */
  poe90: (number | null)[];
  actual: (number | null)[];
}

export interface RegionData {
  demand: Metric;
  rooftopPv: Metric;
}

export interface DayData {
  tradingDate: string;
  forecastIssuedAt: string;
  regions: Record<Region, RegionData>;
}

export interface IndexEntry {
  date: string;
}

export interface LatestEntry {
  date: string;
  path: string;
}

/**
 * Base path the app is deployed under (e.g. "/nemweb" on GitHub Pages).
 * Mirrors `basePath` in next.config.js via the public env var.
 */
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';

const DATA_DIR = `${BASE_PATH}/data`;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Available days, ascending by date. */
export function fetchIndex(): Promise<IndexEntry[]> {
  return fetchJson<IndexEntry[]>(`${DATA_DIR}/index.json`);
}

/** Pointer to the most recent day. */
export function fetchLatest(): Promise<LatestEntry> {
  return fetchJson<LatestEntry>(`${DATA_DIR}/latest.json`);
}

/** Full per-day forecast/actual payload for a given trading date (YYYY-MM-DD). */
export function fetchDay(date: string): Promise<DayData> {
  return fetchJson<DayData>(`${DATA_DIR}/${date}.json`);
}

/**
 * The in-progress trading day's forecast plume (actual arrays empty). Written
 * by the daily ingest as `today.json`; absent until the first run produces it,
 * in which case this rejects and the app falls back to the latest dated day.
 */
export function fetchToday(): Promise<DayData> {
  return fetchJson<DayData>(`${DATA_DIR}/today.json`);
}

/** One day in the demand forecast-error rankings. */
export interface RankingEntry {
  date: string;
  /** Daily mean absolute error between actual demand and day-ahead POE50, MW. */
  maeMw: number;
  /** Mean signed error (actual - forecast); positive = under-forecast. */
  meanSignedErrorMw: number;
  /** Intervals used in the average. */
  intervals: number;
}

export interface Rankings {
  metric: string;
  topN: number;
  /** Top days per region, plus a "NEM" aggregate, sorted by maeMw descending. */
  regions: Record<string, RankingEntry[]>;
}

/** Precomputed top days by demand forecast error (maintained by the ingest). */
export function fetchRankings(): Promise<Rankings> {
  return fetchJson<Rankings>(`${DATA_DIR}/demand-error-rankings.json`);
}

/** Element-wise sum of several series; null if any region is missing that interval. */
function sumSeries(series: (number | null)[][]): (number | null)[] {
  const len = series[0]?.length ?? 0;
  const out: (number | null)[] = [];
  for (let i = 0; i < len; i++) {
    let sum = 0;
    let missing = false;
    for (const s of series) {
      const v = s[i];
      if (v == null) {
        missing = true;
        break;
      }
      sum += v;
    }
    out.push(missing ? null : sum);
  }
  return out;
}

function sumMetric(metrics: Metric[]): Metric {
  return {
    intervals: metrics[0].intervals,
    poe10: sumSeries(metrics.map((m) => m.poe10)),
    poe50: sumSeries(metrics.map((m) => m.poe50)),
    poe90: sumSeries(metrics.map((m) => m.poe90)),
    actual: sumSeries(metrics.map((m) => m.actual)),
  };
}

/**
 * NEM-wide aggregate: sums each interval across all five regions for actuals
 * and all three POE values. Summing percentiles assumes perfect correlation
 * across regions and is statistically wrong — it is only a visual cue, not a
 * true probabilistic band (see the caveat shown in the UI).
 */
export function buildNemRegion(regions: Record<Region, RegionData>): RegionData {
  const list = REGIONS.map((r) => regions[r]);
  return {
    demand: sumMetric(list.map((r) => r.demand)),
    rooftopPv: sumMetric(list.map((r) => r.rooftopPv)),
  };
}
