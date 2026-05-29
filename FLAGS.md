# AEMO convention flags — validated against live data (2026-05-29)

These items were originally assumptions baked into the ingest while the sandbox
couldn't reach `nemweb.com.au`. The environment can now reach the live site, so
each was checked end-to-end against real NEMWEB output (trading day **D =
2026-05-28**, forecast snapshot issued D-1). Result: **one real bug found and
fixed** (directory listing); every documented convention confirmed except the
16:00-vs-17:00 snapshot choice (#3), which is a product decision left open.

Validation method: the live ingest builds a full day with **48/48 non-null
intervals for all five regions**, both demand and rooftop, forecast and actual,
with zero `poe10 ≥ poe50 ≥ poe90` band-ordering violations.

## 0. Directory listing — REAL BUG, FIXED

NEMWEB's Apache index links files by **absolute, upper-cased path**, e.g.

    <A HREF="/Reports/CURRENT/Operational_Demand/ACTUAL_HH/PUBLIC_..._202605280000_....zip">

The original `list_directory` skipped any href starting with `/`, so against the
live site it returned an **empty list** for every report directory — the ingest
could not have fetched anything. The fixtures never caught this because
`LocalSource` lists files from disk and bypasses the HTML parser entirely.

Fixed in `nemweb.py`: hrefs are now resolved against the directory URL
(`urljoin`) and the filename taken as the basename; `?C=...` sort links and the
parent-directory link are still ignored. A network-free regression test
(`test_parse_directory_listing_absolute_hrefs`) now covers the real markup.

## 1. Rooftop POE band orientation — CONFIRMED CORRECT

Real `ROOFTOP_PV` forecast rows satisfy
`POWERPOELOW < POWERPOE50 < POWERPOEHIGH` (e.g. NSW1 midday 925 < 1365 < 1981),
so `POWERPOEHIGH` is the high-generation bound. The mapping is correct:

- `poe10` ← `POWERPOEHIGH`  (high generation, ~10% exceedance)
- `poe90` ← `POWERPOELOW`   (low generation, ~90% exceedance)

This keeps one consistent meaning across demand and rooftop (`poe10` = high
band). Zero band-ordering violations across the validated day. No change needed.

## 2. Report / table naming — CONFIRMED

Live report families, tables and the `Reports/Current/...` paths all match. The
ingest matches tables by **column presence**, which lines up with the real I-row
headers:

| series          | dir                                          | table key                   | key columns                                            |
|-----------------|----------------------------------------------|-----------------------------|--------------------------------------------------------|
| demand forecast | `Operational_Demand/FORECAST_HH`             | `OPERATIONAL_DEMAND_FORECAST` | `OPERATIONAL_DEMAND_POE10/50/90`, `REGIONID`, `INTERVAL_DATETIME` |
| demand actual   | `Operational_Demand/ACTUAL_HH`               | `OPERATIONAL_DEMAND_ACTUAL`   | `OPERATIONAL_DEMAND`, `INTERVAL_DATETIME`              |
| rooftop forecast| `ROOFTOP_PV/FORECAST`                         | `ROOFTOP_FORECAST`            | `POWERPOE50`, `POWERPOELOW`, `POWERPOEHIGH`, `REGIONID`|
| rooftop actual  | `ROOFTOP_PV/ACTUAL`                           | `ROOFTOP_ACTUAL`              | `POWER`, `TYPE`, `REGIONID`, `INTERVAL_DATETIME`       |

Live filenames carry two stamps, `PUBLIC_<report>_<run YYYYMMDDHHMM>_<generated
YYYYMMDDHHMMSS>.zip`; `parse_filename_timestamp` reads the first (run time),
which is what the snapshot picker keys on.

## 3. The "16:00" day-ahead snapshot — OPEN DECISION (no bug)

Operational-demand and rooftop forecasts publish **every 30 minutes**; there is
no special 16:00 file. The picker takes the latest run stamped at or before
**D-1 17:00 AEST**, which on real data selects the **17:00-stamped** run — note
that run was *generated* at 16:32, so in generation-time terms it is ~the 16:30
snapshot. A single forecast run spans ~8 days ahead, so it fully covers D
(48/48 intervals confirmed).

**Decision to confirm:** is the 17:00-stamped run (generated ~16:30) the
intended day-ahead reference, or should the cutoff be D-1 16:00 to pick the
16:00-stamped run (generated ~15:30)? To switch, change `_forecast_cutoff` in
`ingest.py` from `-7h` (17:00) to `-8h` (16:00).

## 4. TAS1 rooftop PV — CONFIRMED present

TAS1 reports rooftop PV in the live `ROOFTOP_PV` reports (48/48 forecast and
actual intervals on the validated day). The all-null path for a genuinely-absent
region remains tested via fixtures, but does not trigger on real TAS1 data.

## 5. ACTUAL_HH → trading-day assignment — CONFIRMED

There is **no consolidated daily file**: each `ACTUAL_HH` file carries a single
half-hour interval (5 rows, one per region) and is published every 30 minutes.
Collecting every file whose **filename timestamp** falls in `[D 00:00, D+1
06:00)` and projecting onto the 48-interval grid assembles exactly 48 intervals.
The interval-ending-00:00 slot (stamped `D+1 00:00`) lands on D's last grid slot
as assumed; files outside D's grid (the +6h slop, and the stray D-00:00 file)
project to nothing and are harmlessly ignored.

## 6. Interval convention & time zone — CONFIRMED

- Intervals are **interval-ending**, 48 per day (00:30 … 24:00 = next day
  00:00). The 48/48 coverage with no off-by-one gap confirms the
  ending-vs-beginning convention.
- AEST fixed at +10:00 (no daylight saving), matching AEMO's publication zone.
  Known prototype limitation; revisit if we ever localise display times.

## 7. Exact actual column names — CONFIRMED

Demand actual is read from `OPERATIONAL_DEMAND`. The live actual table also
carries `OPERATIONAL_DEMAND_ADJUSTMENT` and `WDR_ESTIMATE`; we deliberately use
the unadjusted `OPERATIONAL_DEMAND`. Rooftop actual uses `POWER` with
`TYPE=MEASUREMENT` rows kept and `TYPE=SATELLITE` dropped (the live site
publishes MEASUREMENT and SATELLITE as separate files; the `TYPE` filter handles
both).
