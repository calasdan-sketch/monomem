import test from "node:test";
import assert from "node:assert/strict";
import { DUP_JACCARD, jaccard, nearCopy, wordSet } from "../src/search-diversity.js";

// Deterministic pseudo-random sets from a small vocabulary, so the sizes and overlaps vary widely.
function sets(seed: number, count: number): Array<Set<string>> {
  let x = seed;
  const rnd = (): number => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  return Array.from({ length: count }, () => {
    const size = 1 + Math.floor(rnd() * 30);
    return new Set(Array.from({ length: size }, () => `w${Math.floor(rnd() * 34)}`));
  });
}

test("nearCopy gives the same answer as jaccard >= DUP_JACCARD on every pair", () => {
  // Arrange
  const all = sets(7, 120);
  // Act + Assert
  for (const a of all) for (const b of all) assert.equal(nearCopy(a, b), jaccard(a, b) >= DUP_JACCARD);
});

test("nearCopy is true for identical sets and false for empty ones", () => {
  assert.equal(nearCopy(new Set(["a", "b"]), new Set(["a", "b"])), true);
  assert.equal(nearCopy(new Set(), new Set()), false);
});

test("wordSet finds the same words in ASCII and in accented text, and a cached note keeps its set", () => {
  // Arrange
  const plain = { id: 9001, rev: 1, title: "Deploy Region", body: "We deploy to us-east-1 on Fridays" };
  const accent = { title: "Résumé café", body: "naïve 北京 text" };
  // Act
  const a = wordSet(plain);
  const b = wordSet(accent);
  // Assert
  assert.deepEqual([...a].sort(), ["1", "deploy", "east", "fridays", "on", "region", "to", "us", "we"]);
  assert.deepEqual([...b].sort(), ["café", "naïve", "résumé", "text", "北京"]);
  assert.equal(wordSet({ ...plain }), a);
  assert.notEqual(wordSet({ ...plain, rev: 2, body: "different words here" }), a);
});
