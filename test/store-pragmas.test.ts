// 1.5.0 (round 2, P1): every connection gets the larger page-cache cap.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";

test("P1 page cache is capped at 64 MB, not SQLite's 2 MB default", () => {
  const s = new Store(":memory:");
  try {
    const v = (s.captureDb().prepare("PRAGMA cache_size").get() as { cache_size: number }).cache_size;
    assert.equal(v, Store.CACHE_SIZE_KIB);
    assert.equal(v, -65536);
  } finally {
    s.close();
  }
});
