# Data Contracts

This document records the current data shapes and the target high-level API
contracts. It is intentionally concise so future work can avoid loading
generated data files into AI context.

## Contract Principles

- Source, dataset, analysis, and visualisation are separate concepts.
- Browser-facing responses should come from the Worker API.
- R2 object layouts and D1 table layouts are implementation details.
- Missing numeric values are represented as `null`, not by dropping intervals.
- Trading dates are `YYYY-MM-DD`.
- Current AEMO interval timestamps use fixed AEST (`+10:00`) semantics.

## Normalized Dataset Contract

Source adapters should emit normalized datasets before any frontend-compatible
projection is built. The current Python contract is represented by
`NormalizedDataset` and `NormalizedDay` in `ingest/dataset_contracts.py`.

A normalized dataset describes one regional time-series dataset:

- `id`: stable dataset instance id, e.g.
  `aemo-nemweb.demand.forecast.2026-05-28`
- `source`: source adapter id, e.g. `aemo-nemweb`
- `metric`: semantic metric id such as `demand` or `rooftopPv`
- `kind`: `forecast`, `actual`, or a future normalized data kind
- `cadence`: interval cadence, currently `30m`
- `units`: currently `MW`
- `interval_timezone`: fixed `AEST+10:00` for current AEMO interval timestamps
- `intervals`: complete interval-ending grid; missing values are `null`
- `regions`: region set covered by the dataset
- `values`: region-keyed series, with named value arrays such as `poe10`,
  `poe50`, `poe90`, or `actual`

Normalized datasets are not visualization payloads. The existing
`data/YYYY-MM-DD.json` files are a compatibility projection from normalized
NEMWEB demand/rooftop forecast and actual datasets.

Current NEMWEB normalized dataset families:

- `aemo-nemweb.demand.forecast.DATE`: `poe10`, `poe50`, `poe90`
- `aemo-nemweb.demand.actual.DATE`: `actual`
- `aemo-nemweb.rooftopPv.forecast.DATE`: `poe10`, `poe50`, `poe90`
- `aemo-nemweb.rooftopPv.actual.DATE`: `actual`

The day-ahead forecast cutoff is currently the latest run stamped at or before
D-1 17:00 AEST. The 16:00-vs-17:00 reference remains a product decision; a
future change must update this document and ingest tests in the same change.

## Current Static Data Files

Current frontend fetches are implemented in `lib/data.ts`.

### `data/index.json`

Available historical days, ascending:

```json
[{ "date": "2026-05-28" }]
```

### `data/latest.json`

Pointer to the latest historical day:

```json
{ "date": "2026-05-28", "path": "2026-05-28.json" }
```

### `data/YYYY-MM-DD.json`

Per-day forecast/actual payload:

```json
{
  "tradingDate": "2026-05-28",
  "forecastIssuedAt": "2026-05-27T16:00:00+10:00",
  "regions": {
    "NSW1": {
      "demand": {
        "intervals": ["2026-05-28T00:30+10:00"],
        "poe10": [null],
        "poe50": [null],
        "poe90": [null],
        "actual": [null]
      },
      "rooftopPv": {
        "intervals": ["2026-05-28T00:30+10:00"],
        "poe10": [null],
        "poe50": [null],
        "poe90": [null],
        "actual": [null]
      }
    }
  }
}
```

Expected region keys are `NSW1`, `VIC1`, `QLD1`, `SA1`, and `TAS1`. The current
frontend can synthesize `NEM` by summing regional series.

Each metric has 48 half-hour-ending intervals for the trading day. For POE
bands, current convention is `poe10 >= poe50 >= poe90` for both operational
demand and rooftop PV.

### `data/today.json`

The in-progress trading day's forecast plume using the same shape as a per-day
payload. Actual arrays may be all `null` until live data is overlaid.

### `data/demand-error-rankings.json`

Precomputed analysis output for largest demand forecast errors:

```json
{
  "metric": "demand",
  "topN": 10,
  "regions": {
    "NEM": [
      {
        "date": "2026-05-28",
        "maeMw": 123.4,
        "meanSignedErrorMw": -12.3,
        "intervals": 48
      }
    ]
  }
}
```

## Current Live Data File

Current frontend live fetches are implemented in `lib/live.ts`.

Default URL:

```text
https://raw.githubusercontent.com/c-hat/NEMWEB/live-data/today-live.json
```

High-level shape:

```json
{
  "updatedAt": "2026-05-28T12:00:00+10:00",
  "regions": {
    "NEM": {
      "demand": [{ "ts": "2026-05-28T12:00:00+10:00", "value": 12345 }],
      "rooftopPv": [{ "ts": "2026-05-28T12:00:00+10:00", "value": 1234 }]
    }
  },
  "currentForecast": {
    "demand": {
      "issuedAt": "2026-05-28T10:00:00+10:00",
      "regions": {
        "NSW1": {
          "intervals": ["2026-05-28T12:30+10:00"],
          "poe50": [1000]
        }
      }
    },
    "rooftopPv": {
      "issuedAt": "2026-05-28T10:00:00+10:00",
      "regions": {}
    }
  }
}
```

## Target Worker API

The Worker API should become the browser data boundary. Initial responses may
mirror current static JSON to reduce migration risk.

### `GET /api/catalog`

Returns high-level dataset and analysis availability.

Suggested fields:

- `datasets`: dataset descriptors with id, label, metric, cadence, regions, and
  available date range.
- `analyses`: analysis descriptors with id, label, inputs, parameters, and
  availability.
- `updatedAt`: catalog generation timestamp.

### `GET /api/days`

Returns available trading days.

Compatibility response can match current `index.json`:

```json
[{ "date": "2026-05-28" }]
```

Future response may add metadata without removing `date`.

### `GET /api/latest`

Returns the latest available day.

Compatibility response:

```json
{ "date": "2026-05-28", "path": "2026-05-28.json" }
```

Future response may replace `path` with API links after frontend migration.

### `GET /api/day/:date`

Returns the per-day forecast/actual payload. The initial API can mirror
`data/YYYY-MM-DD.json`.

For the current AEST trading date, the compatibility API may satisfy this route
from `data/today.json` / `compat/today.json` while the settled dated payload is
not yet available. The returned payload must still have `tradingDate` equal to
the requested `:date`.

Future versions may include:

- dataset IDs
- source run IDs
- data quality flags
- generated timestamps
- links to related analyses

### `GET /api/live`

Returns live actuals and current forecast context for the active trading day.
The initial API can mirror the current live file while hiding the storage
location from the browser.

### `GET /api/analyses`

Returns analysis descriptors and availability, not necessarily full payloads.

Descriptor fields:

- `id`
- `type`
- `label`
- `description`
- `inputs`
- `parameters`
- `version`
- `availableDates` or `dateRange`
- `updatedAt`

### `GET /api/analyses/:id`

Returns one analysis payload by ID. Every analysis payload includes:

- `id`
- `type`
- `version`
- `inputs`
- `parameters`
- `generatedAt`
- `data`

IDs identify the analysis definition, never a source file. Payloads are
versioned derived datasets with declared inputs and parameters.

## Analysis Families

Representative analysis types:

- `forecast-vs-actual`
- `forecast-error-ranking`
- `band-breach`
- `regional-contribution`
- `weather-correlation`
- `price-market-overlay`

Analysis IDs should identify the analysis definition, not a source file.

Initial analysis definitions:

- `demand-forecast-error-ranking`
  - type: `forecast-error-ranking`
  - inputs: `aemo-nemweb.demand.forecast`,
    `aemo-nemweb.demand.actual`
  - compatibility projection: current `data/demand-error-rankings.json`
- `band-breach`
  - type: `band-breach`
  - inputs: forecast and actual datasets for a metric
  - data: intervals where actual is above `poe10` or below `poe90`
- `regional-contribution`
  - type: `regional-contribution`
  - inputs: actual or forecast dataset for a metric
  - data: interval total plus per-region shares

## Future Storage Metadata

D1 should eventually track:

- source definitions
- source runs
- raw object references
- normalized dataset availability
- derived analysis availability
- data quality summaries
- schema/contract versions

Initial D1 migration: `worker/migrations/0001_storage_catalog.sql`.

Catalog tables:

- `sources`: source adapter definitions.
- `source_runs`: one fetch/parse/write attempt with params, timing, status,
  error, and internal R2 refs.
- `datasets`: normalized dataset definitions.
- `dataset_availability`: per-dataset, per-date availability and internal
  payload pointer.
- `analyses`: derived analysis definitions.
- `analysis_availability`: generated analysis payload availability.
- `data_quality`: quality summaries by scope/date/metric.
- `schema_versions`: schema and contract version records.

The Worker storage module (`worker/src/storage.ts`) is the owner of R2 key
construction and D1 SQL. Frontend responses must continue to use Worker API
contracts, not D1 rows or R2 object keys.

R2 should eventually store:

- raw source payloads
- normalized dataset payloads
- generated frontend-compatible payloads during migration
- derived analysis payloads

Do not expose R2 object keys as frontend contracts unless they are explicitly
documented as stable public API fields.
