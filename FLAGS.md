# AEMO convention flags — to confirm on the first real Action run

The sandbox can't reach `nemweb.com.au` (egress blocked; allowlist request stuck,
likely bug #19087), so the ingest module was built and tested against synthetic
fixtures that follow the *documented* AEMO MMS schema. The items below are places
where the docs are ambiguous or where the brief and the MMS naming disagree. None
are blocking — the pipeline runs end-to-end on fixtures — but each should be
eyeballed against real output from the first `ingest` workflow run before we build
the frontend (Phase 3).

## 1. Rooftop POE band orientation (most important)

`OPERATIONAL_DEMAND` forecast has explicit `..._POE10/_POE50/_POE90` columns, so
demand maps cleanly: `poe10` = high band (exceeded ~10% of the time).

`ROOFTOP_PV` forecast instead exposes `POWERPOELOW / POWERPOE50 / POWERPOEHIGH`.
To keep one consistent meaning across both series, the ingest maps:

- `poe10` ← `POWERPOEHIGH`  (high generation ≈ 10% exceedance)
- `poe90` ← `POWERPOELOW`   (low generation ≈ 90% exceedance)

This is the opposite of how the original Phase 1 code wired it (it had
`poe10 ← POWERPOELOW`). **Confirm against real data** that `POWERPOEHIGH` is in
fact the high-generation / low-exceedance bound. If AEMO's semantics differ, swap
the two lines in `ingest.py` (`fetch`/`build_day_payload`, rooftop block).

## 2. Report / table naming

The brief refers to `DEMANDOPERATIONALFORECAST` / `DEMANDOPERATIONALACTUAL`. The
live MMS reports are the `OPERATIONAL_DEMAND` report family with `FORECAST_HH` and
`ACTUAL_HH` tables, under:

- `Reports/Current/Operational_Demand/FORECAST_HH/`
- `Reports/Current/Operational_Demand/ACTUAL_HH/`

The ingest matches tables by **column presence** (`OPERATIONAL_DEMAND_POE50`,
`OPERATIONAL_DEMAND`, `POWERPOE50`, `POWER`+`TYPE`) rather than by table name, so
either naming works. Confirm the real directory paths and table names match.

## 3. The "16:00" day-ahead snapshot

Operational-demand and rooftop forecasts publish frequently, not just at 16:00.
We pick the latest snapshot issued **at or before D-1 17:00 AEST** (so a missing
16:00 file falls back to the most recent earlier one). Confirm 16:00-ish is the
intended day-ahead reference, and that the chosen file actually spans all of D.

## 4. TAS1 rooftop PV

The brief lists TAS1 as a possible "region with no rooftop PV". In reality TAS1
*does* report rooftop PV in the AEMO `ROOFTOP_PV` reports. The pipeline handles a
genuinely-absent region by emitting all-null series (tested via fixtures that omit
TAS1), but on real data TAS1 rooftop will almost certainly be populated. Confirm.

## 5. ACTUAL_HH → trading-day assignment

We collect every `ACTUAL_HH` / `ROOFTOP_PV/ACTUAL` file whose **filename
timestamp** falls in `[D 00:00, D+1 06:00)` (the +6h slop catches the late
publish run carrying the interval-ending-00:00 slot that straddles midnight).
This relies on filename time, not file contents. Confirm there isn't instead a
single consolidated daily file, and that interval-ending 00:00 belongs to D
(not D+1) as we assume.

## 6. Interval convention & time zone

- Intervals are treated as **interval-ending**, 48 per day: 00:30 … 24:00 (= next
  day 00:00). Confirm AEMO's ending-vs-beginning convention.
- AEST is fixed at +10:00 (no daylight saving), matching AEMO's publication zone.
  Known prototype limitation; revisit if we ever localise display times.

## 7. Exact actual column names

Demand actual is read from the `OPERATIONAL_DEMAND` column. Confirm there isn't a
preferred adjusted variant (e.g. an operational-vs-adjusted column) we should use.
