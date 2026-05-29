'use client';

import { useEffect, useMemo, useState } from 'react';
import ForecastChart from '@/components/ForecastChart';
import {
  fetchDay,
  fetchIndex,
  fetchLatest,
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
              onClick={() => hasPrev && setSelectedDate(dates[currentIndex - 1])}
              disabled={!hasPrev}
              aria-label="Previous day"
            >
              ‹
            </button>
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
            <button
              type="button"
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
                {r}
              </button>
            ))}
          </div>
        </div>
      </section>

      {day && (
        <section className="context">
          <span>
            <strong>Trading date:</strong> {day.tradingDate}
          </span>
          <span>
            <strong>Forecast issued:</strong> {day.forecastIssuedAt}
          </span>
        </section>
      )}

      {error && <p className="error">Error loading data: {error}</p>}
      {loading && !error && <p className="status">Loading…</p>}

      {!loading && !error && regionData && (
        <section className="charts">
          <ForecastChart title={`${region} — Demand`} unit="MW" metric={regionData.demand} />
          <ForecastChart
            title={`${region} — Rooftop PV`}
            unit="MW"
            metric={regionData.rooftopPv}
          />
        </section>
      )}
    </main>
  );
}
