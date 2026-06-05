# NEMWEB ingest

Daily ingestion of AEMO NEMWEB day-ahead probabilistic forecasts and realised
actuals for operational demand and rooftop PV. Writes one JSON per trading day
to `public/data/` for the static frontend to render.

## Quick start

```bash
cd ingest
uv sync

# One day (trading day D, AEST). Uses the latest forecast run stamped
# at or before D-1 17:00 AEST.
uv run python ingest.py --date 2026-05-27

# Backfill the last 30 days
uv run python ingest.py --backfill 30

# Custom output directory
uv run python ingest.py --date 2026-05-27 --out ../public/data

# Run against local fixtures instead of the live site (no network)
uv run python ingest.py --date 2026-05-28 --source ../tests/fixtures/nemweb
```

## Data source

The ingest only talks to a `Source`, so the **same code path** runs against the
live site and against local fixtures:

- default: the live NEMWEB site (`https://nemweb.com.au`)
- `--source <path>` or `NEMWEB_SOURCE=<path>`: a local directory mirroring the
  NEMWEB layout (used by the tests)
- `--source https://…`: any HTTP(S) mirror

A spec starting with `http://`/`https://` is an HTTP base URL; anything else is a
local fixture directory.

## What it produces

The ingest first builds normalized source-adapter datasets, then projects them
to the current frontend compatibility files. During migration, it still writes
`public/data/YYYY-MM-DD.json` per trading day, plus:
- `latest.json` — `{ "date": "...", "path": "...json" }` pointer
- `index.json`  — `[{ "date": "..." }, ...]` ascending list of all dated files

Per-day schema:

```json
{
  "tradingDate": "2026-05-28",
  "forecastIssuedAt": "2026-05-27T16:00:00+10:00",
  "regions": {
    "NSW1": {
      "demand":    { "intervals": [...], "poe10": [...], "poe50": [...], "poe90": [...], "actual": [...] },
      "rooftopPv": { "intervals": [...], "poe10": [...], "poe50": [...], "poe90": [...], "actual": [...] }
    },
    "VIC1": { ... }, "QLD1": { ... }, "SA1": { ... }, "TAS1": { ... }
  }
}
```

48 half-hour-ending intervals per day (00:30..24:00 AEST). Missing values are
emitted as `null` rather than dropping the slot.

## Normalized datasets

`ingest/dataset_contracts.py` defines the adapter boundary:

- `SourceAdapter` emits normalized datasets for a trading day.
- `NormalizedDataset` records dataset id, source, metric, kind, cadence, units,
  interval timezone, interval grid, region set, and region-keyed value arrays.
- `NormalizedDay` groups the datasets needed to project one trading day.

The current `NemwebDayAdapter` emits four datasets for each day:

- demand forecast (`poe10`, `poe50`, `poe90`)
- demand actual (`actual`)
- rooftop PV forecast (`poe10`, `poe50`, `poe90`)
- rooftop PV actual (`actual`)

The existing per-day JSON is a compatibility projection of those datasets, not
the long-term adapter output.

## Tests

```bash
# Everything (parser unit tests + end-to-end ingest against fixtures)
uv run python -m pytest -q

# Or run the suites directly, no pytest needed:
uv run python test_parser.py            # parser / picker / projection units
uv run python ../tests/test_ingest.py   # full ingest pipeline vs fixtures
```

No network. The end-to-end tests run the real ingest pipeline through a
`LocalSource` pointed at `../tests/fixtures/nemweb`, and cover the documented
edge cases:

- missing forecast snapshots before the cutoff -> explicit ingest skip/error
- current cutoff is D-1 17:00 AEST; the 16:00-vs-17:00 reference is still a
  product decision
- compatibility projection remains byte-identical to the pinned compact payload
  hash for the validated fixture day
- demand error rankings run through the analysis registry while still writing
  the current `demand-error-rankings.json` compatibility shape
- a region absent from the rooftop reports → all-null rooftop series (TAS1)
- the half-hour interval straddling midnight (interval-ending 00:00)
- a genuinely missing actual interval → `null`
- `TYPE=SATELLITE` rooftop rows filtered out in favour of `MEASUREMENT`

Fixtures are plain CSVs (reviewable in git) generated deterministically by
`../tests/fixtures/generate_fixtures.py`. Regenerate with:

```bash
uv run python ../tests/fixtures/generate_fixtures.py
```

## Real-data validation

Validated end-to-end against the live site for trading day 2026-05-28: all five
regions return 48/48 non-null intervals (demand and rooftop, forecast and
actual) with no POE band-ordering violations. This surfaced and fixed one real
bug — the directory-index parser dropped NEMWEB's absolute-path hrefs. See
`../FLAGS.md` for the full validation record and the one remaining product
decision (16:00 vs 17:00 day-ahead snapshot).

The `ingest` workflow (`.github/workflows/ingest.yml`, `workflow_dispatch`)
fetches a real day on a GitHub runner and commits the JSON to `public/data/`;
it's the path used to populate data in CI.

## Known limitations

- AEST is fixed at +10:00; daylight saving is ignored (prototype scope).
- Backfill is best-effort against `Reports/Current/`; days where the source
  files have rolled off are skipped with an explicit warning/error that calls
  out the pending `Reports/ARCHIVE/` fallback. No `ARCHIVE/` fallback is active
  yet because archive files use different bundle granularity.
- Snapshot pick uses the latest forecast run stamped at or before D-1 17:00
  AEST. The open product decision is whether to keep that 17:00-stamped run or
  switch to the 16:00-stamped run.
- AEMO naming/column conventions (including the rooftop POE band orientation,
  `poe10 ← POWERPOEHIGH`) have been confirmed against live data; see
  `../FLAGS.md`. The only open item is whether the day-ahead reference should be
  the 16:00- or 17:00-stamped forecast run.
