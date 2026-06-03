'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchLiveFile, type LiveFile } from './live';

// The live-data Action writes the file roughly every 10 minutes; poll to match.
const POLL_MS = 10 * 60_000;
// >25 min since the file's updatedAt = stale (one missed cron run of headroom).
const STALE_MS = 25 * 60_000;
// Poll ~1 min past each boundary, after the job has had time to push.
const PUBLISH_LAG_MS = 60 * 1000;

export interface LiveDataState {
  /** The latest fetched file (all regions, both metrics), or null before first load. */
  file: LiveFile | null;
  /** Epoch ms parsed from file.updatedAt (when the job last wrote data), or null. */
  updatedAt: number | null;
  /** True when the data is older than the stale threshold (or never loaded). */
  stale: boolean;
}

/**
 * Polls the single live-data file every ~10 min (aligned just past each
 * boundary), pausing while the tab is hidden and catching up on return. One
 * file carries every region and both metrics, so region switches need no
 * refetch. Staleness is driven by the file's own `updatedAt` rather than fetch
 * success, so a missed cron run flips the badge to STALE after >25 min; the
 * badge re-evaluates on a timer so it flips between polls too. No-ops when
 * inactive (past days never poll).
 */
export function useLiveData(active: boolean): LiveDataState {
  const [file, setFile] = useState<LiveFile | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [stale, setStale] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updatedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    // Reset for a fresh activation.
    updatedAtRef.current = null;
    setFile(null);
    setUpdatedAt(null);
    setStale(false);

    async function poll() {
      if (cancelled) return;
      try {
        const f = await fetchLiveFile();
        if (cancelled) return;
        const ms = Date.parse(f.updatedAt);
        const ua = Number.isNaN(ms) ? null : ms;
        setFile(f);
        updatedAtRef.current = ua;
        setUpdatedAt(ua);
        setStale(ua == null ? true : Date.now() - ua > STALE_MS);
      } catch {
        // Keep the last-known file; staleness is judged from its updatedAt,
        // which will cross the threshold on its own if fetches keep failing.
        if (cancelled) return;
        const ua = updatedAtRef.current;
        setStale(ua == null ? true : Date.now() - ua > STALE_MS);
      }
    }

    function schedule() {
      if (cancelled || document.hidden) return;
      const now = Date.now();
      const next = Math.ceil(now / POLL_MS) * POLL_MS + PUBLISH_LAG_MS;
      timer.current = setTimeout(() => {
        void poll().then(schedule);
      }, Math.max(1000, next - now));
    }

    function onVisibility() {
      if (cancelled) return;
      if (document.hidden) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      } else {
        if (timer.current) clearTimeout(timer.current);
        void poll().then(schedule); // immediate catch-up
      }
    }

    void poll().then(schedule);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);

  // Re-evaluate staleness on a timer so the badge flips even between polls.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      const ua = updatedAtRef.current;
      if (ua != null) setStale(Date.now() - ua > STALE_MS);
    }, 30 * 1000);
    return () => clearInterval(id);
  }, [active]);

  return { file, updatedAt, stale };
}
