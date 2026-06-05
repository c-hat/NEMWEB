export interface StorageEnv {
  NEMWEB_BUCKET: R2Bucket;
  NEMWEB_DB: D1Database;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type R2Payload = string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null;
type StoredPayload = R2Payload | JsonValue;

export interface SourceDefinition {
  id: string;
  label: string;
  kind: string;
  config?: JsonValue;
}

export interface SourceRunInput {
  id: string;
  sourceId: string;
  params?: JsonValue;
  startedAt: string;
  finishedAt?: string | null;
  status: 'running' | 'success' | 'failed' | 'skipped';
  error?: string | null;
  r2Refs?: string[];
}

export interface DatasetDefinition {
  id: string;
  label: string;
  metric: string;
  cadence: string;
  regions: string[];
  units: string;
  schemaVersion: string;
}

export interface DatasetAvailabilityInput {
  datasetId: string;
  date: string;
  status: 'available' | 'partial' | 'missing' | 'failed';
  r2Key?: string | null;
  quality?: JsonValue;
  sourceRunId?: string | null;
}

export interface AnalysisDefinition {
  id: string;
  type: string;
  label: string;
  inputs?: string[];
  parameters?: JsonValue;
  version: string;
}

export interface CatalogDataset {
  id: string;
  label: string;
  metric: string;
  cadence: string;
  regions: string[];
  units: string;
  schemaVersion: string;
  dateRange: { start: string; end: string } | null;
}

export interface CatalogAnalysis {
  id: string;
  type: string;
  label: string;
  inputs: string[];
  parameters: JsonValue;
  version: string;
}

export interface Catalog {
  datasets: CatalogDataset[];
  analyses: CatalogAnalysis[];
  updatedAt: string;
}

function json(value: JsonValue | undefined, fallback: JsonValue): string {
  return JSON.stringify(value ?? fallback);
}

function isR2Payload(payload: StoredPayload): payload is R2Payload {
  if (
    typeof payload === 'string' ||
    payload === null ||
    payload instanceof ArrayBuffer ||
    ArrayBuffer.isView(payload) ||
    payload instanceof ReadableStream ||
    payload instanceof Blob
  ) {
    return true;
  }
  return false;
}

function payloadBody(payload: StoredPayload): R2Payload {
  if (isR2Payload(payload)) return payload;
  return JSON.stringify(payload);
}

function contentType(payload: StoredPayload, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (isR2Payload(payload)) return undefined;
  return 'application/json';
}

export function rawKey(source: string, runId: string, filename: string): string {
  return `raw/${source}/${runId}/${filename}`;
}

export function datasetKey(datasetId: string, date: string): string {
  return `dataset/${datasetId}/${date}.json`;
}

export function compatDayKey(date: string): string {
  return `compat/day/${date}.json`;
}

export function compatIndexKey(): string {
  return 'compat/index.json';
}

export function compatLatestKey(): string {
  return 'compat/latest.json';
}

export function compatLiveKey(): string {
  return 'compat/live.json';
}

export function analysisKey(analysisId: string, version: string): string {
  return `analysis/${analysisId}/${version}.json`;
}

async function putObject(
  env: StorageEnv,
  key: string,
  payload: StoredPayload,
  explicitContentType?: string,
): Promise<string> {
  const httpMetadata = contentType(payload, explicitContentType)
    ? { contentType: contentType(payload, explicitContentType) }
    : undefined;
  await env.NEMWEB_BUCKET.put(key, payloadBody(payload), { httpMetadata });
  return key;
}

export function putRaw(
  env: StorageEnv,
  source: string,
  runId: string,
  filename: string,
  payload: StoredPayload,
  contentType?: string,
): Promise<string> {
  return putObject(env, rawKey(source, runId, filename), payload, contentType);
}

export function putDataset(
  env: StorageEnv,
  datasetId: string,
  date: string,
  payload: JsonValue,
): Promise<string> {
  return putObject(env, datasetKey(datasetId, date), payload);
}

export function putCompat(env: StorageEnv, key: string, payload: JsonValue): Promise<string> {
  if (!key.startsWith('compat/')) {
    throw new Error(`compat key must start with compat/: ${key}`);
  }
  return putObject(env, key, payload);
}

export function putAnalysis(
  env: StorageEnv,
  analysisId: string,
  version: string,
  payload: JsonValue,
): Promise<string> {
  return putObject(env, analysisKey(analysisId, version), payload);
}

export async function getJsonObject<T = JsonValue>(env: StorageEnv, key: string): Promise<T | null> {
  const object = await env.NEMWEB_BUCKET.get(key);
  if (!object) return null;
  return object.json<T>();
}

export async function upsertSource(env: StorageEnv, source: SourceDefinition): Promise<void> {
  await env.NEMWEB_DB.prepare(
    `INSERT INTO sources (id, label, kind, config_json, updated_at)
     VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       kind = excluded.kind,
       config_json = excluded.config_json,
       updated_at = excluded.updated_at`,
  )
    .bind(source.id, source.label, source.kind, json(source.config, {}))
    .run();
}

export async function recordRun(env: StorageEnv, run: SourceRunInput): Promise<void> {
  await env.NEMWEB_DB.prepare(
    `INSERT INTO source_runs
       (id, source_id, params_json, started_at, finished_at, status, error, r2_refs_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       finished_at = excluded.finished_at,
       status = excluded.status,
       error = excluded.error,
       r2_refs_json = excluded.r2_refs_json`,
  )
    .bind(
      run.id,
      run.sourceId,
      json(run.params, {}),
      run.startedAt,
      run.finishedAt ?? null,
      run.status,
      run.error ?? null,
      JSON.stringify(run.r2Refs ?? []),
    )
    .run();
}

export async function upsertDataset(env: StorageEnv, dataset: DatasetDefinition): Promise<void> {
  await env.NEMWEB_DB.prepare(
    `INSERT INTO datasets
       (id, label, metric, cadence, regions_json, units, schema_version, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       metric = excluded.metric,
       cadence = excluded.cadence,
       regions_json = excluded.regions_json,
       units = excluded.units,
       schema_version = excluded.schema_version,
       updated_at = excluded.updated_at`,
  )
    .bind(
      dataset.id,
      dataset.label,
      dataset.metric,
      dataset.cadence,
      JSON.stringify(dataset.regions),
      dataset.units,
      dataset.schemaVersion,
    )
    .run();
}

export async function setAvailability(
  env: StorageEnv,
  availability: DatasetAvailabilityInput,
): Promise<void> {
  await env.NEMWEB_DB.prepare(
    `INSERT INTO dataset_availability
       (dataset_id, date, status, r2_key, quality_json, source_run_id, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(dataset_id, date) DO UPDATE SET
       status = excluded.status,
       r2_key = excluded.r2_key,
       quality_json = excluded.quality_json,
       source_run_id = excluded.source_run_id,
       updated_at = excluded.updated_at`,
  )
    .bind(
      availability.datasetId,
      availability.date,
      availability.status,
      availability.r2Key ?? null,
      json(availability.quality, {}),
      availability.sourceRunId ?? null,
    )
    .run();
}

export async function getAvailability(env: StorageEnv, datasetId: string, date: string) {
  return env.NEMWEB_DB.prepare(
    `SELECT dataset_id, date, status, r2_key, quality_json, source_run_id, updated_at
     FROM dataset_availability
     WHERE dataset_id = ?1 AND date = ?2`,
  )
    .bind(datasetId, date)
    .first();
}

export async function upsertAnalysis(env: StorageEnv, analysis: AnalysisDefinition): Promise<void> {
  await env.NEMWEB_DB.prepare(
    `INSERT INTO analyses
       (id, type, label, inputs_json, parameters_json, version, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type,
       label = excluded.label,
       inputs_json = excluded.inputs_json,
       parameters_json = excluded.parameters_json,
       version = excluded.version,
       updated_at = excluded.updated_at`,
  )
    .bind(
      analysis.id,
      analysis.type,
      analysis.label,
      JSON.stringify(analysis.inputs ?? []),
      json(analysis.parameters, {}),
      analysis.version,
    )
    .run();
}

interface DatasetRow {
  id: string;
  label: string;
  metric: string;
  cadence: string;
  regions_json: string;
  units: string;
  schema_version: string;
  start_date: string | null;
  end_date: string | null;
}

interface AnalysisRow {
  id: string;
  type: string;
  label: string;
  inputs_json: string;
  parameters_json: string;
  version: string;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function getCatalog(env: StorageEnv): Promise<Catalog> {
  const datasets = await env.NEMWEB_DB.prepare(
    `SELECT
       d.id,
       d.label,
       d.metric,
       d.cadence,
       d.regions_json,
       d.units,
       d.schema_version,
       MIN(CASE WHEN da.status IN ('available', 'partial') THEN da.date END) AS start_date,
       MAX(CASE WHEN da.status IN ('available', 'partial') THEN da.date END) AS end_date
     FROM datasets d
     LEFT JOIN dataset_availability da ON da.dataset_id = d.id
     GROUP BY d.id
     ORDER BY d.id`,
  ).all<DatasetRow>();

  const analyses = await env.NEMWEB_DB.prepare(
    `SELECT id, type, label, inputs_json, parameters_json, version
     FROM analyses
     ORDER BY id`,
  ).all<AnalysisRow>();

  return {
    datasets: datasets.results.map((row) => ({
      id: row.id,
      label: row.label,
      metric: row.metric,
      cadence: row.cadence,
      regions: parseJson<string[]>(row.regions_json, []),
      units: row.units,
      schemaVersion: row.schema_version,
      dateRange:
        row.start_date && row.end_date ? { start: row.start_date, end: row.end_date } : null,
    })),
    analyses: analyses.results.map((row) => ({
      id: row.id,
      type: row.type,
      label: row.label,
      inputs: parseJson<string[]>(row.inputs_json, []),
      parameters: parseJson<JsonValue>(row.parameters_json, {}),
      version: row.version,
    })),
    updatedAt: new Date().toISOString(),
  };
}
