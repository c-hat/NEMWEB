'use client';

import { useEffect, useMemo, useState } from 'react';
import ForecastChart from '@/components/ForecastChart';
import {
  buildNemRegion,
  fetchDay,
  fetchIndex,
  fetchLatest,
  fetchRankings,
  formatIssued,
  REGION_LABELS,
  SELECTABLE_REGIONS,
  type DayData,
  type Rankings,
  type SelectableRegion,
} from '@/lib/data';

export default function Home() {
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [region, setRegion] = useState<SelectableRegion>('NSW1');
  const [day, setDay] = useState<DayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rankings, setRankings] = useState<Rankings | null>(null);

  // Load the precomputed demand forecast-error rankings once (optional feature;
  // a failure just leaves the "Largest demand errors" menu empty).
  useEffect(() => {
    let cancelled = false;
    fetchRankings().then(
      (r) => !cancelled && setRankings(r),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

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

  const regionData = useMemo(() => {
    if (!day) return null;
    return region === 'NEM' ? buildNemRegion(day.regions) : day.regions[region];
  }, [day, region]);

  // Top demand-error days for the currently selected region.
  const rankingList = rankings?.regions[region] ?? [];

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
            {SELECTABLE_REGIONS.map((r) => (
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

        <div className="control-group errors-control">
          <label htmlFor="errors-select">Largest demand errors</label>
          <select
            id="errors-select"
            className="errors-select"
            value={rankingList.some((e) => e.date === selectedDate) ? selectedDate : ''}
            onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
            disabled={rankingList.length === 0}
          >
            <option value="" disabled>
              {rankingList.length ? `Top ${rankingList.length} — ${REGION_LABELS[region]}` : 'No data'}
            </option>
            {rankingList.map((e, i) => (
              <option key={e.date} value={e.date}>
                {`${i + 1}. ${e.date} · ${Math.round(e.maeMw).toLocaleString('en-AU')} MW avg`}
              </option>
            ))}
          </select>
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
          {region === 'NEM' && (
            <p className="caveat">
              NEM bands are summed across regions — not a true probabilistic band.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
