// `monomem bench --scale N` (C-05): synthetic store in a temp folder, p50/p95 for session start, search and write, with and
// without at-rest encryption. Small N here; the 10k run is in docs/BENCHMARK.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScale, renderScale, runScale } from "../src/bench/scale.js";

test("parseScale reads 10k, 1k and plain numbers, rejects junk", () => {
  assert.equal(parseScale("10k"), 10000);
  assert.equal(parseScale("1K"), 1000);
  assert.equal(parseScale("2500"), 2500);
  for (const bad of ["", "abc", "0", "-5", "1.5k", "10m"]) assert.throws(() => parseScale(bad), /--scale/);
});

test("runScale reports plain and encrypted timings, seals bodies, and only gates at 10k", async () => {
  const r = await runScale({ notes: 120, iterations: 3, writes: 3, hookRuns: 2 });
  assert.equal(r.notes, 120);
  for (const mode of [r.plain, r.encrypted]) {
    for (const k of ["sessionStart", "openAndSessionStart", "search", "searchRealistic", "write", "hookPrompt"] as const) {
      assert.ok(mode[k].p50 > 0 && mode[k].p95 >= mode[k].p50, `${k}: ${JSON.stringify(mode[k])}`);
    }
  }
  assert.equal(r.plain.sealedBodies, 0);
  assert.ok(r.encrypted.sealedBodies >= 120, `sealed: ${r.encrypted.sealedBodies}`);
  assert.equal(r.gate, null);
  // C-06: the encrypted run reports the in-memory body index (built once, by the search store; the hook store never builds it).
  assert.ok(r.encrypted.bodyIndex, "encrypted run reports the body index");
  assert.ok(r.encrypted.bodyIndex.notes >= 120, `indexed: ${r.encrypted.bodyIndex.notes}`);
  assert.ok(r.encrypted.bodyIndex.buildMs > 0);
  assert.equal(typeof r.encrypted.bodyIndex.rssMb, "number");
  assert.equal(r.plain.bodyIndex, undefined);
  // final3 PERF-S1: the common-word mix matches most notes; the realistic mix uses words found in under 5% of them.
  const text = renderScale(r);
  assert.match(text, /keyword search, 2 common words/);
  assert.match(text, /keyword search, 2 realistic words/);
  // r3 A10: the whole-process prompt hook is measured too (gated at 10k, with the session-start gate).
  assert.match(text, /hook user-prompt, whole process/);
});

test("word() never returns undefined, even when the first draw is near 1 and the second near 0", async () => {
  const { word } = await import("../src/bench/scale.js");
  const draws = [0.99999, 0];
  let i = 0;
  assert.equal(typeof word(() => draws[i++ % 2]), "string");
});
