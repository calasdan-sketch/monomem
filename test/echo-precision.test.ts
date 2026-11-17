// Echo guard precision on a hand-labelled set (test/fixtures/echo-pairs.json): 25 true echoes, 25 similar but independent
// notes. Pairs come in topic groups of two; even groups were used to look at the threshold, odd groups are the reported
// half (never tuned on). The numbers here are the ones docs/trust.md states, so the doc cannot drift from the rule.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { echoOf } from "../src/store/taint.js";

interface Pair { echo: boolean; shown: { title: string; body: string }; written: { title: string; body: string } }
const pairs = (JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", "echo-pairs.json"), "utf8")) as { pairs: Pair[] }).pairs;

/** Runs the real rule (echoOf) with the shown note as the only note this connection read. */
function called(p: Pair): boolean {
  const s = new Store(":memory:");
  try {
    const shown = s.create({ title: p.shown.title, body: p.shown.body });
    return actorStore.run({ label: "agent", authed: true, taintedReads: new Map([[shown.id, Date.now()]]) }, () => echoOf(s, p.written.title, p.written.body)) === shown.id;
  } finally {
    s.close();
  }
}

function score(half: Pair[]): { tp: number; fp: number; fn: number; precision: number; recall: number } {
  let tp = 0, fp = 0, fn = 0;
  for (const p of half) {
    const c = called(p);
    if (c && p.echo) tp++;
    else if (c) fp++;
    else if (p.echo) fn++;
  }
  return { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp / (tp + fn) };
}

test("echo guard: the set is 25 echoes + 25 independent notes, split by topic group", () => {
  assert.equal(pairs.length, 50);
  assert.equal(pairs.filter((p) => p.echo).length, 25);
});

test("echo guard precision >= 0.9 on the reported half, and docs/trust.md states the measured numbers", () => {
  const report = pairs.filter((_, i) => Math.floor(i / 2) % 2 === 1);
  const r = score(report);
  assert.ok(r.precision >= 0.9, `precision ${r.precision}`);
  const doc = readFileSync(join(process.cwd(), "docs", "trust.md"), "utf8");
  const line = `precision ${r.precision.toFixed(2)} (${r.tp} of ${r.tp + r.fp}), recall ${r.recall.toFixed(2)} (${r.tp} of ${r.tp + r.fn})`;
  assert.ok(doc.includes(line), `docs/trust.md should say: ${line}`);
});
