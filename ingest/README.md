# NEMWEB ingest

Daily ingestion of AEMO NEMWEB day-ahead probabilistic forecasts and realised
actuals for operational demand and rooftop PV. Writes one JSON per trading day
to `public/data/` for the static frontend to render.

## Quick start

```bash
cd ingest
uv sync

# One day (trading day D, AEST). Uses the forecast snapshot issued ~D-1 16:00 AEST.
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

- missing 16:00 forecast snapshot → falls back to the latest before D-1 17:00
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

The sandbox can't reach `nemweb.com.au`, so live validation runs on GitHub. The
`ingest` workflow (`.github/workflows/ingest.yml`, `workflow_dispatch`) fetches a
real day and commits the JSON to `public/data/`. See `../FLAGS.md` for AEMO
conventions to confirm on that first run.

## Known limitations

- AEST is fixed at +10:00; daylight saving is ignored (prototype scope).
- Backfill is best-effort against `Reports/Current/`; days where the source
  files have rolled off are skipped with a warning. No `ARCHIVE/` fallback.
- Snapshot pick falls back to the latest forecast issued before D-1 17:00 AEST
  if the exact 16:00 file is missing (per the project brief).
- Several AEMO naming/column conventions are assumed from the docs and should be
  confirmed against the first real Action run — notably the rooftop POE band
  orientation (`poe10 ← POWERPOEHIGH`). See `../FLAGS.md`.
