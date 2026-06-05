import { getLive } from './api';
import { USE_API_DATA } from './dataSource';

/**
 * Live-data client for the in-progress trading day.
 *
 * Static mode reads the live-data branch over raw.githubusercontent.com. API
 * mode reads `GET /api/live` first and falls back to the raw URL until the
 * Worker endpoint is proven in production.
 */

/** Live-data file URL. Build-time constant; override via NEXT_PUBLIC_LIVE_DATA_URL. */
export const LIVE_DATA_URL =
  process.env.NEXT_PUBLIC_LIVE_DATA_URL ||
  'https://raw.githubusercontent.com/c-hat/NEMWEB/live-data/today-live.json';

/** A single live observation. */
export interface LivePoint {
  ts: string;
  value: number | null;
}

/** One region's live series for the day. */
export interface LiveRegion {
  demand: LivePoint[];
  rooftopPv: LivePoint[];
}

/** POE50 forecast series for one region (half-hourly intervals). */
export interface ForecastSeries {
  intervals: string[];
  poe50: (number | null)[];
}

/** The current POE50 forecast for all regions, for one metric. */
export interface CurrentForecast {
  /** ISO timestamp of the NEMWEB file that was used (when the forecast was issued). */
  issuedAt: string | null;
  regions: Record<string, ForecastSeries>;
}

/** The published live-data file: all regions (incl. the NEM aggregate) in one object. */
export interface LiveFile {
  /** ISO timestamp of when the scheduled job last wrote the file. */
  updatedAt: string;
  /** Per-region series keyed by AEMO region code (NSW1 … TAS1) plus NEM. */
  regions: Record<string, LiveRegion>;
  /** Most-recent NEMWEB forecast POE50 for the rest of today (may be absent on old files). */
  currentForecast?: {
    demand: CurrentForecast;
    rooftopPv: CurrentForecast;
  };
}

/**
 * Fetch the live-data file. A cache-busting query param defeats
 * raw.githubusercontent.com's ~5-minute CDN cache, so each poll sees the latest
 * force-pushed file rather than a stale edge copy. Throws on network/HTTP error.
 */
async function fetchRawLiveFile(): Promise<LiveFile> {
  const res = await fetch(`${LIVE_DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`live-data ${res.status}`);
  return (await res.json()) as LiveFile;
}

export async function fetchLiveFile(): Promise<LiveFile> {
  if (!USE_API_DATA) return fetchRawLiveFile();
  try {
    return await getLive(true);
  } catch {
    return fetchRawLiveFile();
  }
}
