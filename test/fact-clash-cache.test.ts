// factClash keeps the parsed form of each tags array (the scan behind `check` and `digest` compares every note with many others).
// The cache must not change a single answer, so this compares it with a copy of the original function on random tag sets.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { factClash, noteFacts, canonKey, normFact } from "../src/facts.js";

const reference = (a: readonly string[], b: readonly string[]): boolean => {
  const mine = new Map(noteFacts(a).map(([k, v]) => [canonKey(k), normFact(v)]));
  return noteFacts(b).some(([k, v]) => mine.has(canonKey(k)) && mine.get(canonKey(k)) !== normFact(v));
};

// a small vocabulary on purpose: keys and values collide often, synonyms (hosting / deploy_target) appear, plain tags are mixed in
const KEYS = ["deploy_target", "hosting", "api.deploy_target", "db", "port", "region", "x.port"];
const VALUES = ["render", "Render", "fly  io", "fly io", "8080", "9090", "eu", " eu "];
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function randomTags(r: () => number): string[] {
  const n = Math.floor(r() * 5);
  return Array.from({ length: n }, () => (r() < 0.25 ? `plain${Math.floor(r() * 3)}` : `fact:${KEYS[Math.floor(r() * KEYS.length)]}=${VALUES[Math.floor(r() * VALUES.length)]}`));
}

test("the cached factClash gives the same answer as the original on 20,000 random pairs, in both orders", () => {
  const r = rng(42);
  const pool = Array.from({ length: 200 }, () => randomTags(r));
  let clashes = 0;
  for (let i = 0; i < 20000; i++) {
    const a = pool[Math.floor(r() * pool.length)];
    const b = pool[Math.floor(r() * pool.length)];
    const want = reference(a, b);
    assert.equal(factClash(a, b), want, JSON.stringify([a, b]));
    if (want) clashes++;
  }
  assert.ok(clashes > 500 && clashes < 19000, `the sample must contain both answers (clashes: ${clashes})`);
});

test("an edited note (a new tags array) is parsed afresh, not served from the old entry", () => {
  const a = ["fact:db=postgres"];
  assert.equal(factClash(a, ["fact:db=postgres"]), false);
  assert.equal(factClash(a, ["fact:db=mysql"]), true);
  assert.equal(factClash(["fact:db=mysql"], ["fact:db=mysql"]), false);
});
