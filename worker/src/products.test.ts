import assert from "node:assert/strict";
import test from "node:test";

import { freshestProduct, productFreshness } from "./products";

test("freshestProduct prefers the newer product irrespective of storage", () => {
  const r2 = { updatedAt: "2026-08-09T08:10:00+10:00" };
  const fallback = { updatedAt: "2026-08-09T08:20:00+10:00" };
  assert.equal(freshestProduct(r2, fallback, ["updatedAt"]), fallback);
});

test("productFreshness identifies stale and missing products", () => {
  const now = Date.parse("2026-08-09T00:30:00Z");
  assert.equal(
    productFreshness({ generatedAt: "2026-08-09T00:00:00Z" }, ["generatedAt"], 25, now).stale,
    true,
  );
  assert.deepEqual(productFreshness(null, ["updatedAt"], 25, now), {
    available: false,
    updatedAt: null,
    ageMinutes: null,
    stale: true,
  });
});
