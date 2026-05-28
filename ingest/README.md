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
```

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
uv run python test_parser.py
```

Fixture-driven smoke tests of the AEMO MMS CSV parser, snapshot picker, and
per-region series projection. No network.

## Known limitations

- AEST is fixed at +10:00; daylight saving is ignored (prototype scope).
- Backfill is best-effort against `Reports/Current/`; days where the source
  files have rolled off are skipped with a warning. No `ARCHIVE/` fallback.
- Snapshot pick falls back to the latest forecast issued before D-1 17:00 AEST
  if the exact 16:00 file is missing (per the project brief).
