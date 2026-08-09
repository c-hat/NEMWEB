import type { DayData, IndexEntry, LatestEntry, Rankings } from './data';
import type { LiveFile } from './live';

export interface CatalogDatasetDescriptor {
  id: string;
  label: string;
  metric?: string;
  cadence?: string;
  regions?: string[];
  dateRange?: { start: string; end: string };
}

export interface AnalysisDescriptor {
  id: string;
  type: string;
  label: string;
  description?: string;
  inputs?: string[];
  parameters?: Record<string, unknown>;
  availableDates?: string[];
  dateRange?: { start: string; end: string };
  updatedAt?: string;
}

export interface CatalogResponse {
  datasets: CatalogDatasetDescriptor[];
  analyses: AnalysisDescriptor[];
  updatedAt?: string;
}

export interface AnalysisPayload<TData = unknown> {
  id: string;
  type: string;
  version: string;
  inputs: string[];
  parameters: Record<string, unknown>;
  generatedAt: string;
  data: TData;
}

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '');

function apiPath(path: string): string {
  return `${API_BASE}${path}`;
}

async function fetchApiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiPath(path), { cache: 'no-store', ...init });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function getCatalog(): Promise<CatalogResponse> {
  return fetchApiJson<CatalogResponse>('/api/catalog');
}

export function getDays(): Promise<IndexEntry[]> {
  return fetchApiJson<IndexEntry[]>('/api/days');
}

export function getLatest(): Promise<LatestEntry> {
  return fetchApiJson<LatestEntry>('/api/latest');
}

export function getDay(date: string): Promise<DayData> {
  return fetchApiJson<DayData>(`/api/day/${encodeURIComponent(date)}`);
}

export function getLive(cacheBust = false): Promise<LiveFile> {
  const suffix = cacheBust ? `?t=${Date.now()}` : '';
  return fetchApiJson<LiveFile>(`/api/live${suffix}`);
}

export function getAnalyses(): Promise<AnalysisDescriptor[]> {
  return fetchApiJson<AnalysisDescriptor[]>('/api/analyses');
}

export function getAnalysis<TData = unknown>(id: string): Promise<AnalysisPayload<TData>> {
  return fetchApiJson<AnalysisPayload<TData>>(`/api/analyses/${encodeURIComponent(id)}`);
}

export function getDemandErrorRankings(): Promise<Rankings> {
  return getAnalysis<Rankings>('demand-forecast-error-ranking').then((payload) => payload.data);
}
