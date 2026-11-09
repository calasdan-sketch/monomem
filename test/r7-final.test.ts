// Round 7 final review fixes: writer label cannot shorten into a marker; consolidation honours approve-first.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";
import { resolveConsolidationNotes } from "../src/consolidate.js";
import { buildSummary } from "../src/recall.js";

test("a token labelled 'cli (x' is never shortened to look like the cli marker", () => {
  const s = new Store(":memory:");
  setProcessWriter("cli");
  const a = s.create({ title: "a", body: "x" });
  const t1 = s.create({ title: "b", body: "y" }, { writtenBy: "cli (x" });
  const t2 = s.create({ title: "c", body: "z" }, { writtenBy: "cli (x" });
  setProcessWriter("");
  const out = buildSummary([s.read(a.id)!, s.read(t1.id)!, s.read(t2.id)!] as never);
  assert.doesNotMatch(String(out), /^- cli: /m);
  s.close();
});

test("an agent cannot merge notes in an approve-first namespace; the operator can", () => {
  const s = new Store(":memory:");
  setProcessWriter("cli");
  const a = s.create({ namespace: "team", title: "a", body: "x" });
  const b = s.create({ namespace: "team", title: "b", body: "y" });
  s.setApproveFirst("team", true);
  setProcessWriter("stdio");
  assert.throws(() => resolveConsolidationNotes(s, [a.id, b.id]), /approve-first/);
  setProcessWriter("cli");
  assert.doesNotThrow(() => resolveConsolidationNotes(s, [a.id, b.id]));
  setProcessWriter("");
  s.close();
});
