// The adaptive-attacker winners (2026-11-23): shape of the data file and the registered replay set. The set is expected to REACH today
// (it was built from texts that passed), so this pins only the data, never a verdict: a later linter change may close rows freely.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTIVE, ADAPTIVE_GOALS } from "../src/attack-sets/data-adaptive-2026-11.js";
import { findSet } from "../src/attack-sets/index.js";

test("adaptive set: at most 100 unique rows, valid goal index and field", () => {
  assert.ok(ADAPTIVE.length > 0 && ADAPTIVE.length <= 100);
  assert.equal(new Set(ADAPTIVE.map((r) => r[0])).size, ADAPTIVE.length);
  assert.equal(new Set(ADAPTIVE.map((r) => `${r[2]}|${r[4].toLowerCase()}`)).size, ADAPTIVE.length);
  for (const [, g, field, before, text] of ADAPTIVE) {
    assert.ok(g >= 0 && g < ADAPTIVE_GOALS.length);
    assert.ok(["title", "body", "tags", "source", "fact"].includes(field));
    assert.ok(before.length > 0 && text.length > 0);
  }
});

test("adaptive set: hostile addresses are .invalid or example.com only", () => {
  for (const r of ADAPTIVE) {
    for (const host of r[4].match(/(?:https?:\/\/|@)[a-z0-9.-]+/gi) ?? []) assert.match(host, /\.invalid$|example\.com$/i, `${r[0]}: ${host}`);
  }
});

test("adaptive set is registered and yields one field-level sample per row", async () => {
  const set = findSet("adaptive");
  assert.ok(set);
  const samples = await set.samples();
  assert.equal(samples.length, ADAPTIVE.length);
  assert.ok(samples.every((s) => s.title !== undefined));
});
