import { getForecasterBriefing, getSystemContext } from './api';
import { USE_API_DATA } from './dataSource';
import type { CurrentForecast, LivePoint } from './live';

const RAW_BASE =
  process.env.NEXT_PUBLIC_LIVE_CONTEXT_BASE_URL ||
  'https://raw.githubusercontent.com/c-hat/NEMWEB/live-data';

export interface RegionSystemMetrics {
  operationalDemand: {
    observedAt: string | null;
    currentMw: number | null;
    rampsMw: { '5m': number | null; '30m': number | null; '60m': number | null };
  };
  underlyingDemand: {
    observedAt: string | null;
    currentMw: number | null;
    definition: string;
  };
}

export interface RooftopArea {
  areaId: string;
  label: string;
  region: string;
  actual: Array<LivePoint & { quality?: number | null; estimateType?: string | null }>;
  forecast?: {
    intervals: string[];
    mean: (number | null)[];
    poe50: (number | null)[];
    poe10: (number | null)[];
    poe90: (number | null)[];
  };
}

export interface DuidAsset {
  duid: string;
  facilityCode?: string | null;
  facilityName?: string | null;
  region?: string | null;
  fueltech?: string | null;
  status?: string | null;
  capacityMw?: number | null;
  observedAt: string;
  currentMw: number;
  previousMw?: number | null;
  deltaMw?: number | null;
}

export interface BindingConstraint {
  constraintId: string;
  rhs: number | null;
  lhs: number | null;
  marginalValue: number;
  violationDegree: number;
}

export interface InterconnectorContext {
  interconnectorId: string;
  meteredMw: number | null;
  targetMw: number | null;
  exportLimitMw: number | null;
  importLimitMw: number | null;
  marginalValue: number | null;
  violationDegree: number | null;
  exportConstraintId?: string | null;
  importConstraintId?: string | null;
}

export interface ReserveRegion {
  minimumSurplusReserveMw: number | null;
  minimumAt: string | null;
  worstLorCondition: number;
  intervals: Array<{
    ts: string;
    surplusReserveMw: number | null;
    maxSpareCapacityMw: number | null;
    lorCondition: number;
    demandPoe50Mw: number | null;
    windUigfMw: number | null;
    solarUigfMw: number | null;
  }>;
}

export interface MeteorologicalForecastPoint {
  ts: string;
  rooftopPvMw: number | null;
  utilitySolarUigfMw: number;
  totalSolarMw: number | null;
  operationalDemandMw: number;
  residualDemandMw: number;
  windUigfMw: number | null;
}

export interface MeteorologicalRegion {
  solar: {
    rooftopPvMw: number | null;
    rooftopObservedAt: string | null;
    utilityScaleMw: number | null;
    utilityObservedAt: string | null;
    utilityDeltaMw: number | null;
    totalEstimateMw: number | null;
    rampsMw: { '30m': number | null; '60m': number | null };
    series: Array<{
      ts: string;
      rooftopPvMw: number;
      utilitySolarMw: number;
      totalSolarMw: number;
    }>;
  };
  residualDemand: {
    currentMw: number | null;
    observedAt: string | null;
    rampsMw: { '30m': number | null; '60m': number | null };
    series: Array<{
      ts: string;
      operationalDemandMw: number;
      utilitySolarMw: number;
      residualDemandMw: number;
    }>;
  };
  utilitySolar: {
    currentMw: number | null;
    deltaMw: number | null;
    observedAt: string | null;
    series: LivePoint[];
  };
  wind: {
    currentMw: number | null;
    deltaMw: number | null;
    observedAt: string | null;
    rampsMw: { '30m': number | null; '60m': number | null };
    series: LivePoint[];
  };
  forecast: MeteorologicalForecastPoint[];
}

export interface SystemContext {
  schemaVersion: string;
  updatedAt: string;
  tradingDate: string;
  sources: Record<string, { updatedAt?: string | null; status: string; source?: string; error?: string }>;
  regions: Record<string, RegionSystemMetrics>;
  currentForecast: { demand?: CurrentForecast; rooftopPv?: CurrentForecast };
  rooftopPvAreas: {
    actualIssuedAt: string | null;
    forecastIssuedAt: string | null;
    areas: Record<string, RooftopArea>;
  };
  duidScada: { observedAt: string | null; assets: DuidAsset[] };
  dispatch: {
    observedAt: string | null;
    regions: Record<string, Record<string, number | null>>;
    bindingConstraints: BindingConstraint[];
    interconnectors: InterconnectorContext[];
  };
  reserve: { runAt: string | null; horizonHours: number; regions: Record<string, ReserveRegion> };
  meteorologicalContext: {
    definition: string;
    regions: Record<string, MeteorologicalRegion>;
  };
  quality: { status: 'complete' | 'partial'; errors: Array<{ source: string; message: string }> };
}

export type EventSeverity = 'critical' | 'warning' | 'watch' | 'info';

export interface ForecasterEvent {
  id: string;
  type: string;
  status: string;
  severity: EventSeverity;
  scope: { kind: string; id: string; region?: string | null };
  observedAt: string | null;
  headline: string;
  detail: string;
  metrics: Record<string, unknown>;
  evidence: string[];
  confidence: string;
}

export interface ForecasterBriefing {
  schemaVersion: string;
  generatedAt: string;
  comparedWith: string | null;
  summary: string;
  changes: Array<{ eventId: string; severity: EventSeverity; headline: string; detail: string }>;
  events: ForecasterEvent[];
}

async function rawJson<T>(filename: string): Promise<T> {
  const response = await fetch(`${RAW_BASE}/${filename}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${filename} ${response.status}`);
  return response.json() as Promise<T>;
}

export async function fetchSystemContext(): Promise<SystemContext> {
  if (USE_API_DATA) {
    try {
      return await getSystemContext(true);
    } catch {
      // The compatibility branch remains a temporary migration fallback.
    }
  }
  return rawJson<SystemContext>('system-context.json');
}

export async function fetchForecasterBriefing(): Promise<ForecasterBriefing> {
  if (USE_API_DATA) {
    try {
      return await getForecasterBriefing(true);
    } catch {
      // The compatibility branch remains a temporary migration fallback.
    }
  }
  return rawJson<ForecasterBriefing>('forecaster-briefing.json');
}
