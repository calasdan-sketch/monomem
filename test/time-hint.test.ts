// A date phrase inside a search ("in June", "last week") softly boosts notes written in that window (or up to
// TIME_HINT_SLACK_DAYS after it). Nothing outside the window is dropped.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { boostTimeWindow, queryTimeWindow, runRelevantSearch, runSearch } from "../src/search-service.js";
import type { NoteRecord } from "../src/store.js";

const asOf = new Date("2023-08-01T12:00:00Z");

test("a note written in the named month outranks an equal match from another month", async () => {
  const store = new Store(":memory:");
  const march = store.create({ title: "Camping trip", body: "We went camping by the lake, camping all weekend.", created_at: "2023-03-10T12:00:00Z" });
  const june = store.create({ title: "Lake weekend", body: "We went camping by the lake.", created_at: "2023-06-10T12:00:00Z" });
  // Without a date phrase the March note (more matches) is first; "in June" lifts the June note above it.
  assert.equal((await runSearch(store, "when did we go camping", { mode: "keyword", limit: 5, asOf }))[0]?.id, march.id);
  const hits = await runSearch(store, "when did we go camping in June", { mode: "keyword", limit: 5, asOf });
  assert.equal(hits[0]?.id, june.id);
  assert.ok(hits.some((n) => n.id === march.id), "the other month is still returned");
  const rel = await runRelevantSearch(store, "camping in June", { limit: 5, asOf });
  assert.equal(rel.results[0]?.id, june.id);
});

test("the slack covers notes written just after the window, and no phrase means no window", () => {
  const n = (id: number, at: string) => ({ note: { id, created_at: at } as unknown as NoteRecord, score: 1 });
  const win = queryTimeWindow("what happened in June", asOf)!;
  const out = boostTimeWindow([n(1, "2023-05-20T00:00:00Z"), n(2, "2023-07-04T00:00:00Z"), n(3, "2023-07-30T00:00:00Z")], win);
  assert.deepEqual(out.map((h) => h.note.id), [2, 1, 3]);
  assert.equal(queryTimeWindow("deploy region", asOf), null);
  assert.equal(queryTimeWindow("   ", asOf), null);
});

test("a clock time alone is not used as a date window", () => {
  assert.equal(queryTimeWindow("error at 10:30", asOf), null);
  assert.ok(queryTimeWindow("what did we decide today", asOf));
});

// r8: once a date phrase became a window, its words ("10 days ago", "last Saturday") are not also searched for: in chat
// history "days ago" is everywhere and pulled unrelated notes up.
test("the date phrase's words are not searched for once they became a window", async () => {
  const { topicQuery } = await import("../src/search-service.js");
  assert.equal(topicQuery("What kitchen appliance did I buy 10 days ago?"), "What kitchen appliance did I buy?");
  assert.equal(topicQuery("Who did I go with to the music event last Saturday?"), "Who did I go with to the music event?");
  assert.equal(topicQuery("deploy region"), "deploy region", "no window: unchanged");
  assert.equal(topicQuery("what did I do yesterday"), "what did I do yesterday", "nothing left but stop words: unchanged");
  const store = new Store(":memory:");
  const smoker = store.create({ title: "Smoker", body: "Bought a new kitchen appliance, a smoker.", created_at: "2023-07-22T12:00:00Z" });
  for (let i = 0; i < 6; i++) store.create({ title: `Chat ${i}`, body: `A few days ago, 10 days ago, days ago I said hi. Kitchen talk ${i}.`, created_at: "2023-05-01T12:00:00Z" });
  const hits = await runSearch(store, "What kitchen appliance did I buy 10 days ago?", { mode: "keyword", limit: 5, asOf });
  assert.equal(hits[0]?.id, smoker.id);
});

test("a relative phrase next to an absolute date is kept (the date is the window)", async () => {
  const { topicQuery } = await import("../src/search-service.js");
  const q = "What did Maria do last weekend before April 10, 2023?";
  assert.equal(topicQuery(q, asOf), q);
});
