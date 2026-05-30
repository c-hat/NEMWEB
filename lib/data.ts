/**
 * Client-side data access for the NEMWEB forecast tracker.
 *
 * Data is fetched at runtime from the static `public/data/` directory so newly
 * ingested days appear without rebuilding the app. All paths are prefixed with
 * the configured base path to stay GitHub-Pages-subpath friendly.
 */

export const REGIONS = ['NSW1', 'VIC1', 'QLD1', 'SA1', 'TAS1'] as const;
export type Region = (typeof REGIONS)[number];

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
