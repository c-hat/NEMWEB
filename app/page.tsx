'use client';

import { useEffect, useMemo, useState } from 'react';
import ForecastChart from '@/components/ForecastChart';
import {
  fetchDay,
  fetchIndex,
  fetchLatest,
  formatIssued,
  REGION_LABELS,
  REGIONS,
  type DayData,
  type Region,
} from '@/lib/data';

export default function Home() {
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [region, setRegion] = useState<Region>('NSW1');
  const [day, setDay] = useState<DayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load the day index and the latest-day pointer once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [index, latest] = await Promise.all([fetchIndex(), fetchLatest()]);
        if (cancelled) return;
        const ascending = index.map((e) => e.date);
        setDates(ascending);
        setSelectedDate(latest.date || ascending[ascending.length - 1] || '');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected day's payload whenever the date changes.
  useEffect(() => {
    if (!selectedDate) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await fetchDay(selectedDate);
        if (!cancelled) setDay(data);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setDay(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDate]);

  const currentIndex = dates.indexOf(selectedDate);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < dates.length - 1;

  const regionData = useMemo(() => day?.regions[region] ?? null, [day, region]);

  return (
    <main className="container">
      <header className="page-header">
        <h1>NEMWEB Forecast Tracker</h1>
        <p className="subtitle">
          Half-hourly demand &amp; rooftop PV forecasts (POE bands) vs actuals
        </p>
      </header>

      <section className="controls">
        <div className="control-group">
          <label htmlFor="date-select">Trading date</label>
          <div className="date-nav">
            <button
              type="button"
              className="chevron"
              onClick={() => hasPrev && setSelectedDate(dates[currentIndex - 1])}
              disabled={!hasPrev}
              aria-label="Previous day"
            >
              ‹
            </button>
            <span className="date-field">
              <svg
                className="cal-icon"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
              >
                <rect x="3" y="4.5" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <line x1="3" y1="9" x2="21" y2="9" stroke="currentColor" strokeWidth="1.6" />
                <line x1="8" y1="2.5" x2="8" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <line x1="16" y1="2.5" x2="16" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <select
                id="date-select"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              >
                {dates.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </span>
            <button
              type="button"
              className="chevron"
              onClick={() => hasNext && setSelectedDate(dates[currentIndex + 1])}
              disabled={!hasNext}
              aria-label="Next day"
            >
              ›
            </button>
          </div>
        </div>

        <div className="control-group">
          <label>Region</label>
          <div className="region-switcher" role="group" aria-label="Region">
            {REGIONS.map((r) => (
              <button
                key={r}
                type="button"
                className={r === region ? 'active' : ''}
                onClick={() => setRegion(r)}
              >
                {REGION_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
      </section>

      {day && (
        <p className="context">
          <strong>Forecast issued:</strong> {formatIssued(day.forecastIssuedAt)}
        </p>
      )}

      {error && <p className="error">Error loading data: {error}</p>}
      {loading && !error && <p className="status">Loading…</p>}

      {!loading && !error && regionData && (
        <section className="charts">
          <ForecastChart
            title={`${REGION_LABELS[region]} — Demand`}
            unit="MW"
            metric={regionData.demand}
          />
          <ForecastChart
            title={`${REGION_LABELS[region]} — Rooftop PV`}
            unit="MW"
            metric={regionData.rooftopPv}
          />
        </section>
      )}
    </main>
  );
}
