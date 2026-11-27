// 30-F7 / 31-L1: the CJK pair scan keeps what FTS found when it fails, and is skipped on a very large store.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { cjkTopUp, SCAN_CAP, SCAN_MAX_NOTES } from "../src/store/cjk-search.js";

const scope = { live: "1=1", rangeSql: "", rangeParams: [] };

test("a failing scan returns the rows FTS already found instead of throwing", () => {
  const db = { prepare: () => { throw new Error("database disk image is malformed"); } } as unknown as DatabaseSync;
  const have = [{ id: 1 }];
  assert.deepEqual(cjkTopUp(db, have, "部署流程说明", 10, scope), have);
});

test("a store above the note ceiling is not scanned at all", () => {
  let scanned = false;
  const db = { prepare: (sql: string) => ({ get: () => ({ c: SCAN_MAX_NOTES + 1 }), all: () => ((scanned = true), []) , sql }) } as unknown as DatabaseSync;
  assert.deepEqual(cjkTopUp(db, [], "部署流程说明", 10, scope), []);
  assert.equal(scanned, false);
  assert.ok(SCAN_CAP <= 500);
});
