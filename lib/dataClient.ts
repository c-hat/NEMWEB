import * as api from './api';
import * as staticData from './data';
import { USE_API_DATA } from './dataSource';

export function fetchIndex(): Promise<staticData.IndexEntry[]> {
  return USE_API_DATA ? api.getDays() : staticData.fetchIndex();
}

export function fetchLatest(): Promise<staticData.LatestEntry> {
  return USE_API_DATA ? api.getLatest() : staticData.fetchLatest();
}

export function fetchDay(date: string): Promise<staticData.DayData> {
  return USE_API_DATA ? api.getDay(date) : staticData.fetchDay(date);
}

export function fetchToday(): Promise<staticData.DayData> {
  if (!USE_API_DATA) return staticData.fetchToday();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane' }).format(
    new Date(),
  );
  return api.getDay(today);
}

export function fetchRankings(): Promise<staticData.Rankings> {
  return USE_API_DATA ? api.getDemandErrorRankings() : staticData.fetchRankings();
}

export {
  buildNemRegion,
  formatIssued,
  REGION_LABELS,
  REGIONS,
  SELECTABLE_REGIONS,
} from './data';

export type {
  DayData,
  IndexEntry,
  LatestEntry,
  Metric,
  RankingEntry,
  Rankings,
  Region,
  RegionData,
  SelectableRegion,
} from './data';
