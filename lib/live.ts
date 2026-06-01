/**
 * Live-data client for the in-progress trading day.
 *
 * All live fetches go through the Cloudflare Worker proxy (never directly to
 * OpenElectricity). Times are handled in AEST (UTC+10, no DST) to match AEMO,
 * independent of the viewer's local timezone.
 */

/** Worker base URL. Build-time constant; override via NEXT_PUBLIC_WORKER_URL. */
export const WORKER_URL =
  process.env.NEXT_PUBLIC_WORKER_URL || 'https://nemweb-proxy.nemwebber.workers.dev';

/** A single live observation. */
export interface LivePoint {
  ts: string;
  value: number | null;
}

export interface LiveResult {
  points: LivePoint[];
  /** Worker served last-known data because the upstream was unavailable. */
  stale: boolean;
}

const AEST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Brisbane',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Wall-clock time in AEST as an ISO string with a fixed +10:00 offset. */
export function aestISO(d: Date = new Date()): string {
  const p: Record<string, string> = {};
  for (const part of AEST_PARTS.formatToParts(d)) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour; // en-CA emits 24 at midnight
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}+10:00`;
}

/** AEST calendar date (YYYY-MM-DD). */
export function aestToday(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(d);
}

/** Midnight (00:00) AEST for a YYYY-MM-DD date, as an ISO string. */
export function startOfAestDay(date: string): string {
  return `${date}T00:00:00+10:00`;
}

/** Fetch a live series for [from, to] via the Worker. Throws on network/HTTP error. */
async function fetchLive(
  kind: 'demand' | 'rooftop',
  region: string,
  from: string,
  to: string,
): Promise<LiveResult> {
  const url =
    `${WORKER_URL}/${kind}?region=${encodeURIComponent(region)}` +
    `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`worker ${res.status}`);
  const body = (await res.json()) as { points?: LivePoint[] };
  return { points: body.points ?? [], stale: res.headers.get('X-Stale') === 'true' };
}

/** 5-minute operational demand. */
export function fetchLiveDemand(region: string, from: string, to: string): Promise<LiveResult> {
  return fetchLive('demand', region, from, to);
}

/** 30-minute rooftop PV (native ASEFS2 cadence). */
export function fetchLiveRooftop(region: string, from: string, to: string): Promise<LiveResult> {
  return fetchLive('rooftop', region, from, to);
}
