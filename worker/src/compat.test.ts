import assert from "node:assert/strict";
import test from "node:test";

import {
  dayTradingDate,
  freshestLive,
  mergedDayIndex,
  mostCompleteDay,
  newestLatest,
} from "./compat";
import type { JsonValue } from "./storage";

function dayPayload(date: string, actual: number | null, forecast: number | null = null): JsonValue {
  const actuals = [actual, actual, actual];
  const forecasts = [forecast, forecast, forecast];
  return {
    tradingDate: date,
    regions: {
      NSW1: {
        demand: { actual: actuals, poe10: forecasts, poe50: forecasts, poe90: forecasts },
        rooftopPv: { actual: actuals, poe10: forecasts, poe50: forecasts, poe90: forecasts },
      },
      VIC1: {
        demand: { actual: actuals, poe10: forecasts, poe50: forecasts, poe90: forecasts },
        rooftopPv: { actual: actuals, poe10: forecasts, poe50: forecasts, poe90: forecasts },
      },
    },
  };
}

test("newestLatest prefers the fallback when its date is newer than stale R2", () => {
  const r2 = { date: "2026-06-04", path: "2026-06-04.json" };
  const fallback = { date: "2026-06-05", path: "2026-06-05.json" };

  assert.equal(newestLatest(r2, fallback), fallback);
});

test("mergedDayIndex exposes dates that are only present in the fallback", () => {
  const r2 = [{ date: "2026-06-04" }];
  const fallback = [{ date: "2026-06-04" }, { date: "2026-06-05" }];

  assert.deepEqual(mergedDayIndex(r2, fallback), [
    { date: "2026-06-04" },
    { date: "2026-06-05" },
  ]);
});

test("mostCompleteDay prefers a settled fallback over a forecast-only R2 day", () => {
  const r2 = dayPayload("2026-06-05", null);
  const fallback = dayPayload("2026-06-05", 100);

  assert.equal(mostCompleteDay(r2, fallback), fallback);
});

test("mostCompleteDay keeps R2 when it is at least as complete as fallback", () => {
  const r2 = dayPayload("2026-06-05", 100);
  const fallback = dayPayload("2026-06-05", null);

  assert.equal(mostCompleteDay(r2, fallback), r2);
});

test("mostCompleteDay uses forecast completeness to break actual-count ties", () => {
  const r2 = dayPayload("2026-06-06", null);
  const fallback = dayPayload("2026-06-06", null, 100);

  assert.equal(mostCompleteDay(r2, fallback), fallback);
});

test("dayTradingDate returns the day payload trading date only when valid", () => {
  assert.equal(dayTradingDate(dayPayload("2026-06-06", null)), "2026-06-06");
  assert.equal(dayTradingDate({ tradingDate: "06-06-2026" }), null);
  assert.equal(dayTradingDate(null), null);
});

test("freshestLive keeps using the most recent updatedAt timestamp", () => {
  const r2 = { updatedAt: "2026-06-06T08:40:00+10:00" };
  const fallback = { updatedAt: "2026-06-06T08:50:00+10:00" };

  assert.equal(freshestLive(r2, fallback), fallback);
});
