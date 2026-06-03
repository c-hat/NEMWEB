'use client';

import { useEffect, useMemo, useState } from 'react';
import ForecastChart from '@/components/ForecastChart';
import { downloadCsv, regionDataToCsv } from '@/lib/csv';
import {
  buildNemRegion,
  REGIONS,
  fetchDay,
  fetchIndex,
  fetchLatest,
  fetchRankings,
  fetchToday,
  formatIssued,
  REGION_LABELS,
  SELECTABLE_REGIONS,
  type DayData,
  type Rankings,
  type SelectableRegion,
} from '@/lib/data';
import { useLiveData } from '@/lib/useLiveData';
import type { ForecastBand, ForecastEntry, LiveForecastSeries } from '@/lib/live';

/** Extract per-metric forecast series for a region, summing across regions for NEM. */
function buildLiveForecastSeries(
  entries: ForecastEntry[],
  region: SelectableRegion,
  metric: 'demand' | 'rooftopPv',
): LiveForecastSeries[] {
  return entries
    .map((fc): LiveForecastSeries | null => {
      let band: ForecastBand | undefined;
      if (region === 'NEM') {
        const bands = REGIONS.map((r) => fc.regions[r]?.[metric]).filter(
          (b): b is ForecastBand => b != null,
        );
        if (!bands.length) return null;
        const ref = bands[0];
        const len = ref.intervals.length;
        const sumArr = (arrs: (number | null)[][]): (number | null)[] =>
          Array.from({ length: len }, (_, i) => {
            const vals = arrs.map((a) => a[i]);
            return vals.some((v) => v == null) ? null : vals.reduce<number>((s, v) => s + v!, 0);
          });
        band = {
          intervals: ref.intervals,
          poe10: sumArr(bands.map((b) => b.poe10)),
          poe50: sumArr(bands.map((b) => b.poe50)),
          poe90: sumArr(bands.map((b) => b.poe90)),
        };
      } else {
        band = fc.regions[region]?.[metric];
      }
      if (!band) return null;
      return { issuedAt: fc.issuedAt, ...band };
    })
    .filter((s): s is LiveForecastSeries => s !== null);
}

export default function Home() {
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [region, setRegion] = useState<SelectableRegion>('NSW1');
  const [day, setDay] = useState<DayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rankings, setRankings] = useState<Rankings | null>(null);
  // today.json: the in-progress trading day's forecast plume (null until the
  // ingest has produced it). Its trading date marks the "live" day.
  const [todayData, setTodayData] = useState<DayData | null>(null);
  const todayDate = todayData?.tradingDate ?? null;

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

  // Load the day index, latest-day pointer, and today.json once on mount.
  // today.json is optional: if present we default to it (live view); otherwise
  // we fall back to the most recent dated day.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [index, latest, today] = await Promise.all([
          fetchIndex(),
          fetchLatest(),
          fetchToday().catch(() => null),
        ]);
        if (cancelled) return;
        const ascending = index.map((e) => e.date);
        if (today) {
          // today.json isn't in the index; append it so it stays navigable
          // (otherwise picking "today" would snap to the latest dated day).
          if (!ascending.includes(today.tradingDate)) ascending.push(today.tradingDate);
          setTodayData(today);
          setDates(ascending);
          setSelectedDate(today.tradingDate);
        } else {
          setDates(ascending);
          setSelectedDate(latest.date || ascending[ascending.length - 1] || '');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected day's payload whenever the date changes. Today is served
  // from the already-loaded today.json (it has no dated file yet); past days
  // are fetched as usual.
  useEffect(() => {
    if (!selectedDate) return;
    if (todayDate && selectedDate === todayDate && todayData) {
      setDay(todayData);
      setError(null);
      setLoading(false);
      return;
    }
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
  }, [selectedDate, todayDate, todayData]);

  const currentIndex = dates.indexOf(selectedDate);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < dates.length - 1;

  const dateSet = useMemo(() => new Set(dates), [dates]);

  // The date picker allows any day in [min, max]; if a gap day is chosen, snap
  // to the nearest available date so navigation stays on real data.
  function pickDate(value: string) {
    if (!value || !dates.length) return;
    if (dateSet.has(value)) {
      setSelectedDate(value);
      return;
    }
    let prev: string | null = null;
    let next: string | null = null;
    for (const d of dates) {
      if (d < value) prev = d;
      else if (d > value) {
        next = d;
        break;
      }
    }
    let snapped = prev ?? next;
    if (prev && next) {
      const dp = Date.parse(value) - Date.parse(prev);
      const dn = Date.parse(next) - Date.parse(value);
      snapped = dp <= dn ? prev : next;
    }
    if (snapped) setSelectedDate(snapped);
  }

  // Today usually has no data yet (the ingest lags a day). Extend the picker's
  // max to today so its native "Today" button is selectable; pickDate() then
  // snaps that choice to the most recent available day.
  const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(
    new Date(),
  );
  const maxDate =
    dates.length && dates[dates.length - 1] > todayISO ? dates[dates.length - 1] : todayISO;

  const regionData = useMemo(() => {
    if (!day) return null;
    return region === 'NEM' ? buildNemRegion(day.regions) : day.regions[region];
  }, [day, region]);

  // Live view is active only when today.json is loaded and today is selected.
  // One hook fetches the whole live-data file (all regions, both metrics); it
  // no-ops when inactive. Region switches read from the file with no refetch.
  const isLive = !!todayDate && selectedDate === todayDate && !!todayData;
  const live = useLiveData(isLive);
  const liveRegion = live.file?.regions[region];

  // Pre-dispatch forecast trail, extracted per metric for the current region.
  const demandForecasts = useMemo(
    () =>
      isLive && live.file?.forecasts?.length
        ? buildLiveForecastSeries(live.file.forecasts, region, 'demand')
        : undefined,
    [isLive, live.file, region],
  );
  const rooftopForecasts = useMemo(
    () =>
      isLive && live.file?.forecasts?.length
        ? buildLiveForecastSeries(live.file.forecasts, region, 'rooftopPv')
        : undefined,
    [isLive, live.file, region],
  );

  // Top demand-error days for the currently selected region.
  const rankingList = rankings?.regions[region] ?? [];

  function handleDownloadCsv() {
    if (!regionData || !selectedDate) return;
    const csv = regionDataToCsv(regionData);
    downloadCsv(`nemweb_${region}_${selectedDate}.csv`, csv);
  }

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
            <input
              type="date"
              id="date-select"
              className="date-input"
              min={dates[0]}
              max={maxDate}
              value={selectedDate}
              onChange={(e) => pickDate(e.target.value)}
            />
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

        <div className="control-group download-control">
          <label>&nbsp;</label>
          <button
            type="button"
            className="download-btn"
            onClick={handleDownloadCsv}
            disabled={!regionData}
            title="Download the displayed day and region as CSV"
          >
            ↓ Download CSV
          </button>
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
            liveActual={isLive ? (liveRegion?.demand ?? []) : undefined}
            forecasts={demandForecasts}
            live={isLive}
            stale={live.stale}
            lastUpdated={live.updatedAt}
          />
          <ForecastChart
            title={`${REGION_LABELS[region]} — Rooftop PV`}
            unit="MW"
            metric={regionData.rooftopPv}
            liveActual={isLive ? (liveRegion?.rooftopPv ?? []) : undefined}
            forecasts={rooftopForecasts}
            live={isLive}
            stale={live.stale}
            lastUpdated={live.updatedAt}
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
