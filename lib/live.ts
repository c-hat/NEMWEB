/**
 * Live-data client for the in-progress trading day.
 *
 * Live actuals are published as a single JSON file on the force-pushed
 * `live-data` branch by the scheduled `live-data` GitHub Action, and read here
 * over raw.githubusercontent.com — the same trust domain as the rest of the
 * site, so it isn't blocked by corporate firewalls the way a third-party origin
 * (the old Cloudflare Worker) can be. Times are AEST (UTC+10, no DST) to match
 * AEMO, independent of the viewer's timezone.
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

/** The published live-data file: all regions (incl. the NEM aggregate) in one object. */
export interface LiveFile {
  /** ISO timestamp of when the scheduled job last wrote the file. */
  updatedAt: string;
  /** Per-region series keyed by AEMO region code (NSW1 … TAS1) plus NEM. */
  regions: Record<string, LiveRegion>;
}

/**
 * Fetch the live-data file. A cache-busting query param defeats
 * raw.githubusercontent.com's ~5-minute CDN cache, so each poll sees the latest
 * force-pushed file rather than a stale edge copy. Throws on network/HTTP error.
 */
export async function fetchLiveFile(): Promise<LiveFile> {
  const res = await fetch(`${LIVE_DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`live-data ${res.status}`);
  return (await res.json()) as LiveFile;
}
