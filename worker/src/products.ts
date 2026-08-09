import { isJsonRecord } from "./compat";
import type { JsonValue } from "./storage";

export function productTimestamp(body: JsonValue | null, fields: string[]): number {
  if (!isJsonRecord(body)) return Number.NaN;
  for (const field of fields) {
    const value = body[field];
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

export function freshestProduct(
  r2Body: JsonValue | null,
  fallbackBody: JsonValue | null,
  fields: string[],
): JsonValue | null {
  if (r2Body == null) return fallbackBody;
  if (fallbackBody == null) return r2Body;
  const r2Time = productTimestamp(r2Body, fields);
  const fallbackTime = productTimestamp(fallbackBody, fields);
  return Number.isFinite(fallbackTime) && (!Number.isFinite(r2Time) || fallbackTime > r2Time)
    ? fallbackBody
    : r2Body;
}

export function productFreshness(
  body: JsonValue | null,
  fields: string[],
  staleMinutes: number,
  now = Date.now(),
) {
  const timestamp = productTimestamp(body, fields);
  const updatedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  const ageMinutes = Number.isFinite(timestamp)
    ? Math.max(0, Math.round((now - timestamp) / 60_000))
    : null;
  return {
    available: body != null,
    updatedAt,
    ageMinutes,
    stale: ageMinutes == null ? true : ageMinutes > staleMinutes,
  };
}
