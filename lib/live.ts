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

/** POE band series from a single pre-dispatch forecast snapshot. */
export interface ForecastBand {
  /** AEST half-hour interval timestamps ("YYYY-MM-DDTHH:MM+10:00"). */
  intervals: string[];
  /** High POE band (exceeded only ~10% of the time). */
  poe10: (number | null)[];
  poe50: (number | null)[];
  /** Low POE band. */
  poe90: (number | null)[];
}

/** Demand + rooftop PV bands for one region within a single forecast snapshot. */
export interface ForecastRegion {
  demand?: ForecastBand;
  rooftopPv?: ForecastBand;
}

/**
 * One pre-dispatch forecast snapshot, issued every 30 minutes.
 * Intervals run from approximately issuedAt through 24:00 of the trading day.
 */
export interface ForecastEntry {
  /** AEST ISO timestamp when this snapshot was published ("YYYY-MM-DDTHH:MM+10:00"). */
  issuedAt: string;
  /** Per-region forecast bands (NSW1 … TAS1; no NEM — sum client-side). */
  regions: Record<string, ForecastRegion>;
}

/** The published live-data file: all regions (incl. the NEM aggregate) in one object. */
export interface LiveFile {
  /** ISO timestamp of when the scheduled job last wrote the file. */
  updatedAt: string;
  /** Per-region actuals series keyed by AEMO region code (NSW1 … TAS1) plus NEM. */
  regions: Record<string, LiveRegion>;
  /**
   * Rolling trail of the last ~3 hours of pre-dispatch forecast snapshots,
   * sorted oldest → newest. Present from the first cron run that fetches NEMWEB.
   */
  forecasts?: ForecastEntry[];
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
