'use client';

import { useEffect, useRef, useState } from 'react';
import {
  aestISO,
  fetchLiveDemand,
  fetchLiveRooftop,
  startOfAestDay,
  type LivePoint,
  type LiveResult,
} from './live';

type Fetcher = (region: string, from: string, to: string) => Promise<LiveResult>;

const PUBLISH_LAG_MS = 40 * 1000; // align polls ~40s past the interval boundary

export interface LiveSeriesState {
  points: LivePoint[];
  /** Epoch ms of the last successful fresh (non-stale) fetch, or null. */
  lastUpdated: number | null;
  stale: boolean;
}

/**
 * Polls the Worker for the current trading day's actuals and appends new
 * intervals. Backfills 00:00→now on activation, then polls every `pollMs`
 * aligned to ~40s past each boundary. Polling pauses while the tab is hidden
 * and catches up immediately on return. On error/stale it keeps the last-known
 * series and flags `stale` (after `staleMs` without a fresh fetch).
 */
function useLiveSeries(
  region: string,
  active: boolean,
  todayDate: string,
  fetcher: Fetcher,
  pollMs: number,
  staleMs: number,
): LiveSeriesState {
  const [points, setPoints] = useState<LivePoint[]>([]);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

  const pointsRef = useRef<LivePoint[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUpdatedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || !todayDate) return;
    let cancelled = false;

    // Reset for a fresh (re)activation or region switch.
    pointsRef.current = [];
    lastUpdatedRef.current = null;
    setPoints([]);
    setLastUpdated(null);
    setStale(false);

    function mergeAppend(incoming: LivePoint[]) {
      if (incoming.length === 0) return;
      const byTs = new Map<string, LivePoint>();
      for (const p of pointsRef.current) byTs.set(p.ts, p);
      for (const p of incoming) byTs.set(p.ts, p);
      const merged = [...byTs.values()].sort((a, b) => a.ts.localeCompare(b.ts));
      pointsRef.current = merged;
      setPoints(merged);
    }

    async function poll(initial: boolean) {
      if (cancelled) return;
      const to = aestISO();
      const last = pointsRef.current[pointsRef.current.length - 1];
      const from =
        initial || !last
          ? startOfAestDay(todayDate)
          : aestISO(new Date(Date.parse(last.ts) + pollMs));
      try {
        const { points: pts, stale: st } = await fetcher(region, from, to);
        if (cancelled) return;
        mergeAppend(pts);
        if (st) {
          setStale(true);
        } else {
          const now = Date.now();
          lastUpdatedRef.current = now;
          setLastUpdated(now);
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true); // keep last-known points; retry next cycle
      }
    }

    function schedule() {
      if (cancelled || document.hidden) return;
      const now = Date.now();
      const next = Math.ceil(now / pollMs) * pollMs + PUBLISH_LAG_MS;
      timer.current = setTimeout(
        () => {
          void poll(false).then(schedule);
        },
        Math.max(1000, next - now),
      );
    }

    function onVisibility() {
      if (cancelled) return;
      if (document.hidden) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      } else {
        if (timer.current) clearTimeout(timer.current);
        void poll(false).then(schedule); // immediate catch-up
      }
    }

    void poll(true).then(schedule);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [region, active, todayDate, fetcher, pollMs]);

  // Re-evaluate staleness on a timer so the badge flips even between polls.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const lu = lastUpdatedRef.current;
      if (lu != null) setStale(Date.now() - lu > staleMs);
    }, 30 * 1000);
    return () => clearInterval(id);
  }, [active, staleMs]);

  return { points, lastUpdated, stale };
}

/** Live 5-minute demand: polls every 5 min, stale after >10 min without a fresh fetch. */
export function useLiveDemand(region: string, active: boolean, todayDate: string): LiveSeriesState {
  return useLiveSeries(region, active, todayDate, fetchLiveDemand, 5 * 60_000, 10 * 60_000);
}

/** Live 30-minute rooftop PV: polls every 30 min, stale after >35 min without a fresh fetch. */
export function useLiveRooftop(region: string, active: boolean, todayDate: string): LiveSeriesState {
  return useLiveSeries(region, active, todayDate, fetchLiveRooftop, 30 * 60_000, 35 * 60_000);
}
