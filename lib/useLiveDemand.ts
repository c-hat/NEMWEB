'use client';

import { useEffect, useRef, useState } from 'react';
import { aestISO, fetchLiveDemand, startOfAestDay, type LivePoint } from './live';

const POLL_MS = 5 * 60 * 1000; // demand publishes every 5 minutes
const PUBLISH_LAG_MS = 40 * 1000; // align polls ~40s past the interval boundary
const STALE_MS = 10 * 60 * 1000; // >10 min without a fresh fetch → stale

export interface LiveDemandState {
  points: LivePoint[];
  /** Epoch ms of the last successful fresh (non-stale) fetch, or null. */
  lastUpdated: number | null;
  stale: boolean;
}

/**
 * Polls the Worker for the current trading day's 5-minute demand and appends
 * new intervals. Backfills 00:00→now on activation, then polls every 5 minutes
 * aligned to ~40s past each boundary. Polling pauses while the tab is hidden
 * and catches up immediately on return. On error/stale it keeps the last-known
 * series and flags `stale`.
 */
export function useLiveDemand(region: string, active: boolean, todayDate: string): LiveDemandState {
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
          : aestISO(new Date(Date.parse(last.ts) + POLL_MS));
      try {
        const { points: pts, stale: st } = await fetchLiveDemand(region, from, to);
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
      const next = Math.ceil(now / POLL_MS) * POLL_MS + PUBLISH_LAG_MS;
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
  }, [region, active, todayDate]);

  // Re-evaluate staleness on a timer so the badge flips even between polls.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const lu = lastUpdatedRef.current;
      if (lu != null) setStale(Date.now() - lu > STALE_MS);
    }, 30 * 1000);
    return () => clearInterval(id);
  }, [active]);

  return { points, lastUpdated, stale };
}
