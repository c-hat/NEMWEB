import type { JsonValue } from "./storage";

export function isJsonRecord(value: JsonValue | null): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function timestampMs(value: JsonValue | null): number {
  if (!value || !isJsonRecord(value)) return Number.NaN;
  const updatedAt = jsonString(value.updatedAt);
  return updatedAt ? Date.parse(updatedAt) : Number.NaN;
}

export function freshestLive(r2Body: JsonValue | null, fallbackBody: JsonValue | null): JsonValue | null {
  if (r2Body == null) return fallbackBody;
  if (fallbackBody == null) return r2Body;

  const r2Time = timestampMs(r2Body);
  const fallbackTime = timestampMs(fallbackBody);
  if (Number.isFinite(r2Time) && Number.isFinite(fallbackTime) && fallbackTime > r2Time) {
    return fallbackBody;
  }
  return r2Body;
}

function dateString(value: JsonValue | undefined): string | null {
  const date = jsonString(value);
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

export function newestLatest(
  r2Body: JsonValue | null,
  fallbackBody: JsonValue | null,
): JsonValue | null {
  if (r2Body == null) return fallbackBody;
  if (fallbackBody == null) return r2Body;
  if (!isJsonRecord(r2Body) || !isJsonRecord(fallbackBody)) return r2Body;

  const r2Date = dateString(r2Body.date);
  const fallbackDate = dateString(fallbackBody.date);
  if (r2Date && fallbackDate && fallbackDate > r2Date) {
    return fallbackBody;
  }
  return r2Body;
}

function indexEntries(value: JsonValue | null): { date: string; entry: JsonValue }[] | null {
  if (!Array.isArray(value)) return null;
  const entries: { date: string; entry: JsonValue }[] = [];
  for (const entry of value) {
    if (!isJsonRecord(entry)) continue;
    const date = dateString(entry.date);
    if (date) entries.push({ date, entry });
  }
  return entries;
}

export function mergedDayIndex(
  r2Body: JsonValue | null,
  fallbackBody: JsonValue | null,
): JsonValue | null {
  if (r2Body == null) return fallbackBody;
  if (fallbackBody == null) return r2Body;

  const r2Entries = indexEntries(r2Body);
  const fallbackEntries = indexEntries(fallbackBody);
  if (!r2Entries || !fallbackEntries) return r2Body;

  const byDate = new Map<string, JsonValue>();
  for (const { date, entry } of r2Entries) byDate.set(date, entry);
  for (const { date, entry } of fallbackEntries) byDate.set(date, entry);
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry);
}

function countActualValues(value: JsonValue | null): number {
  if (!isJsonRecord(value) || !isJsonRecord(value.regions)) return 0;

  let count = 0;
  for (const region of Object.values(value.regions)) {
    if (!isJsonRecord(region)) continue;
    for (const metric of ["demand", "rooftopPv"]) {
      const block = region[metric];
      if (!isJsonRecord(block) || !Array.isArray(block.actual)) continue;
      count += block.actual.filter((point) => typeof point === "number" && Number.isFinite(point)).length;
    }
  }
  return count;
}

export function mostCompleteDay(
  r2Body: JsonValue | null,
  fallbackBody: JsonValue | null,
): JsonValue | null {
  if (r2Body == null) return fallbackBody;
  if (fallbackBody == null) return r2Body;

  const r2Actuals = countActualValues(r2Body);
  const fallbackActuals = countActualValues(fallbackBody);
  if (fallbackActuals > r2Actuals) {
    return fallbackBody;
  }
  return r2Body;
}
