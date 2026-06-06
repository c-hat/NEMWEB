import assert from "node:assert/strict";
import test from "node:test";

import {
  freshestLive,
  mergedDayIndex,
  mostCompleteDay,
  newestLatest,
} from "./compat";
import type { JsonValue } from "./storage";

function dayPayload(date: string, actual: number | null): JsonValue {
  const values = [actual, actual, actual];
  return {
    tradingDate: date,
    regions: {
      NSW1: {
        demand: { actual: values },
        rooftopPv: { actual: values },
      },
      VIC1: {
        demand: { actual: values },
        rooftopPv: { actual: values },
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

test("freshestLive keeps using the most recent updatedAt timestamp", () => {
  const r2 = { updatedAt: "2026-06-06T08:40:00+10:00" };
  const fallback = { updatedAt: "2026-06-06T08:50:00+10:00" };

  assert.equal(freshestLive(r2, fallback), fallback);
});
