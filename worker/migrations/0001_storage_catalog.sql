-- D1 catalog schema for NEMWEB storage migration.
-- Payload bodies live in R2; D1 stores metadata, availability, and indexes.

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS source_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  error TEXT,
  r2_refs_json TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE INDEX IF NOT EXISTS idx_source_runs_source_started
  ON source_runs(source_id, started_at DESC);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  metric TEXT NOT NULL,
  cadence TEXT NOT NULL,
  regions_json TEXT NOT NULL,
  units TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS dataset_availability (
  dataset_id TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'partial', 'missing', 'failed')),
  r2_key TEXT,
  quality_json TEXT NOT NULL DEFAULT '{}',
  source_run_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (dataset_id, date),
  FOREIGN KEY (dataset_id) REFERENCES datasets(id),
  FOREIGN KEY (source_run_id) REFERENCES source_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_dataset_availability_date
  ON dataset_availability(date);

CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  parameters_json TEXT NOT NULL DEFAULT '{}',
  version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS analysis_availability (
  analysis_id TEXT NOT NULL,
  date_or_range TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'partial', 'missing', 'failed')),
  quality_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (analysis_id, date_or_range),
  FOREIGN KEY (analysis_id) REFERENCES analyses(id)
);

CREATE TABLE IF NOT EXISTS data_quality (
  scope TEXT NOT NULL,
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (scope, date, metric)
);

CREATE TABLE IF NOT EXISTS schema_versions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
