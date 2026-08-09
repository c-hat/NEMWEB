'use client';

import { useEffect, useRef, useState } from 'react';
import {
  fetchForecasterBriefing,
  fetchSystemContext,
  type ForecasterBriefing,
  type SystemContext,
} from './systemContext';

const POLL_MS = 10 * 60_000;
const STALE_MS = 25 * 60_000;

export interface SystemContextState {
  context: SystemContext | null;
  briefing: ForecasterBriefing | null;
  stale: boolean;
}

/** Independently polls additive system context; failures never affect legacy charts. */
export function useSystemContext(active: boolean): SystemContextState {
  const [context, setContext] = useState<SystemContext | null>(null);
  const [briefing, setBriefing] = useState<ForecasterBriefing | null>(null);
  const [stale, setStale] = useState(false);
  const updatedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function poll() {
      const [contextResult, briefingResult] = await Promise.allSettled([
        fetchSystemContext(),
        fetchForecasterBriefing(),
      ]);
      if (cancelled) return;
      if (contextResult.status === 'fulfilled') {
        const next = contextResult.value;
        const timestamp = Date.parse(next.updatedAt);
        updatedAt.current = Number.isNaN(timestamp) ? null : timestamp;
        setContext(next);
      }
      if (briefingResult.status === 'fulfilled') setBriefing(briefingResult.value);
      setStale(updatedAt.current == null || Date.now() - updatedAt.current > STALE_MS);
    }
    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => {
      setStale(updatedAt.current == null || Date.now() - updatedAt.current > STALE_MS);
    }, 30_000);
    return () => clearInterval(interval);
  }, [active]);

  return { context, briefing, stale };
}
