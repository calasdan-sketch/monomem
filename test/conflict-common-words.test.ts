// r8: conflict detection on save must not rank the whole store for words that every note contains (save time grew with the
// store: 55 ms per save at 35k notes of templated text).
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { findConflictCandidates } from "../src/conflict-detect.js";

test("in a big store the words found in most notes are left out of the conflict query; a rare subject word still finds its note", async () => {
  const s = new Store(":memory:", { bodyIndex: "off" });
  const notes = Array.from({ length: 2100 }, (_, i) => ({ title: `status ${i}`, body: `The deployment pipeline configuration uses standard documentation template ${i === 7 ? "zebrafish" : "filler"} ${i}` }));
  await s.importNotes(notes as never, { deferEdges: true, lockMs: 60000 } as never);
  const calls: string[] = [];
  const orig = s.searchRanked.bind(s);
  s.searchRanked = ((q: string, o: never) => (calls.push(q), orig(q, o))) as never;
  const fresh = s.create({ title: "status new", body: "The deployment pipeline configuration uses standard documentation template zebrafish is no longer enabled" });
  findConflictCandidates(s, fresh);
  assert.ok(calls.length >= 1, "a query was made");
  for (const q of calls) {
    assert.doesNotMatch(q, /deployment|pipeline|configuration|documentation|standard|template/i, `common words must not be in the query: ${q}`);
    assert.match(q, /zebrafish/i);
  }
  s.close();
});
