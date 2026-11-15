// The store split (1.5.0) moves method bodies into src/store/*.ts but keeps every Store method as a delegate, because
// callers and tests reach them (some through `as any`, some by monkeypatching). This snapshot fails if a split step
// drops one. Adding methods is fine; to remove one on purpose, delete its name from store-prototype-names.json.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "store-prototype-names.json");

test("Store.prototype keeps every method name in the snapshot", () => {
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as string[];
  assert.ok(expected.length > 200, "the snapshot loaded");
  const have = new Set(Object.getOwnPropertyNames(Store.prototype));
  assert.deepEqual(expected.filter((n) => !have.has(n)), [], "Store lost a method: keep a one-line delegate on Store for every moved method");
});
