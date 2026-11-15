// 1.5.0 GAP-OBSOLETE-UNREPLACED: the restated-twin rule of the twin pass (search-service.ts demoteTwins), one guard at a time.
// An older note moves directly behind a newer one only for the same writer, the same namespace, the same subject, a near tie,
// with the newer note inside the window and not held, distrusted or outranked by a person's confirm. Nothing is ever dropped.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store, type NoteRecord } from "../src/store.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { rankHits, runSearch, runSearchExplained, runRelevantSearch, RESTATE_MAX_RATIO, RESTATE_MIN_SIM, type RestatedNote } from "../src/search-service.js";
import { stalenessConfig } from "../src/staleness.js";

afterEach(() => setProcessWriter(""));
const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** Place a note `days` in the past (written then). */
function at(s: Store, id: number, days: number): void {
  s.captureDb().prepare("UPDATE notes SET updated_at = ?, created_at = ?, content_at = ? WHERE id = ?").run(ago(days), ago(days), ago(days), id);
}
/** The note as a search hands it to ranking (through the visible read, so labels such as unconfirmed are set). */
const rec = (s: Store, id: number): NoteRecord => s.readVisible(id, { includeDistrusted: true })!;

interface World { s: Store; old: number; neu: number }
/** alice writes a fact, then (a day later) restates it with another value. */
function world(o: { newWriter?: string; newNs?: string; newTags?: string[]; outside?: boolean } = {}): World {
  const s = new Store(":memory:");
  const old = as("alice", () => s.create({ title: "quarzo build server", body: "The quarzo build server is kalmuth.", tags: ["fact:build_server=kalmuth"] })).id;
  const neu = as(o.newWriter ?? "alice", () =>
    s.create({
      ...(o.newNs ? { namespace: o.newNs } : {}),
      title: "quarzo build server moved",
      body: "Update: quarzo builds moved off the old box; the build server is now prendal.",
      tags: o.newTags ?? ["fact:build_server=prendal"],
      ...(o.outside ? { outside: true } : {}),
    })
  ).id;
  at(s, old, 2);
  at(s, neu, 1);
  return { s, old, neu };
}

/** Rank [old, new] with the given scores (old first, as BM25 ranks the shorter note). */
function rank(w: World, oldScore = 1.2, newScore = 1, limit?: number): RestatedNote[] {
  return rankHits(w.s, [{ note: rec(w.s, w.old), score: oldScore }, { note: rec(w.s, w.neu), score: newScore }], stalenessConfig(), limit);
}
const ids = (r: NoteRecord[]): number[] => r.map((n) => n.id);

describe("restated-twin rule", () => {
  test("same writer, same fact key with another value, near tie: the newer note goes first, the older one is labelled", () => {
    const w = world();
    const r = rank(w);
    assert.deepEqual(ids(r), [w.neu, w.old]);
    assert.equal(r[1].restated_by, w.neu);
    assert.match(r[1].restated_label!, new RegExp(`#${w.neu}\\b`));
    assert.equal(r[0].restated_by, undefined);
    w.s.close();
  });

  test("a different writer never reorders (the dispute marker covers it)", () => {
    const w = world({ newWriter: "bob" });
    const r = rank(w);
    assert.deepEqual(ids(r), [w.old, w.neu]);
    assert.ok(r.every((n) => n.restated_by === undefined));
    w.s.close();
  });

  test("not a near tie: a clearly better match keeps its place", () => {
    const w = world();
    assert.deepEqual(ids(rank(w, RESTATE_MAX_RATIO * 1 + 0.01, 1)), [w.old, w.neu]);
    assert.deepEqual(ids(rank(w, RESTATE_MAX_RATIO * 1, 1)), [w.neu, w.old], "the ratio bound itself still moves");
    w.s.close();
  });

  test("the newer note must be inside the window", () => {
    const w = world();
    assert.deepEqual(ids(rank(w, 1.2, 1, 1)), [w.old, w.neu]);
    w.s.close();
  });

  test("another namespace never reorders", () => {
    const w = world({ newNs: "other" });
    assert.deepEqual(ids(rank(w)), [w.old, w.neu]);
    w.s.close();
  });

  test("an older note edited after the newer one was written is not restated by it", () => {
    const w = world();
    w.s.captureDb().prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), w.old);
    assert.deepEqual(ids(rank(w)), [w.old, w.neu]);
    w.s.close();
  });

  test("another subject (no shared fact key, no close similarity link) does not reorder", () => {
    const w = world({ newTags: ["fact:api_server=prendal"] });
    w.s.captureDb().prepare("DELETE FROM note_edges").run();
    assert.deepEqual(ids(rank(w)), [w.old, w.neu]);
    w.s.close();
  });

  test("the same fact value is not a restatement; a close similarity link without facts is", () => {
    const same = world({ newTags: ["fact:build_server=kalmuth"] });
    same.s.captureDb().prepare("DELETE FROM note_edges").run();
    assert.deepEqual(ids(rank(same)), [same.old, same.neu]);
    same.s.close();
    const linked = world({ newTags: [] });
    const edge = (score: number) => linked.s.captureDb().prepare("UPDATE note_edges SET score = ?").run(score);
    assert.ok((linked.s.captureDb().prepare("SELECT COUNT(*) AS n FROM note_edges").get() as { n: number }).n > 0, "the two texts are linked");
    edge(RESTATE_MIN_SIM);
    assert.deepEqual(ids(rank(linked)), [linked.neu, linked.old], "a link at the bar counts");
    edge(RESTATE_MIN_SIM - 0.01);
    assert.deepEqual(ids(rank(linked)), [linked.old, linked.neu], "a weaker link does not");
    linked.s.close();
  });

  test("a person-confirmed note is never moved behind an unconfirmed one; behind a confirmed one it is", () => {
    const w = world();
    setProcessWriter("cli");
    assert.equal(w.s.confirm(w.old)!.kind, "human");
    assert.deepEqual(ids(rank(w)), [w.old, w.neu]);
    assert.equal(w.s.confirm(w.neu)!.kind, "human");
    assert.deepEqual(ids(rank(w)), [w.neu, w.old]);
    w.s.close();
  });

  test("unconfirmed outside content never acts as the newer note", () => {
    const w = world({ outside: true });
    assert.equal(rec(w.s, w.neu).unconfirmed, true);
    assert.deepEqual(ids(rank(w)), [w.old, w.neu]);
    w.s.close();
  });

  test("a distrusted writer's note never acts as the newer note (an admin's include_distrusted read)", () => {
    const w = world();
    w.s.distrustAdd("default", "alice");
    assert.deepEqual(ids(rank(w)), [w.old, w.neu]);
    w.s.close();
  });

  test("captured rows are left to their own session logic", () => {
    const s = new Store(":memory:");
    const old = s.create({ title: "quarzo build server", body: "b", tags: ["fact:build_server=kalmuth"] }, { kind: "observation", sessionId: "s1", obsType: "change" }).id;
    const neu = s.create({ title: "quarzo build server moved", body: "b", tags: ["fact:build_server=prendal"] }, { kind: "observation", sessionId: "s1", obsType: "change" }).id;
    at(s, old, 2);
    at(s, neu, 1);
    assert.deepEqual(ids(rankHits(s, [{ note: rec(s, old), score: 1.2 }, { note: rec(s, neu), score: 1 }])), [old, neu]);
    s.close();
  });

  test("the output is a permutation of the input: nothing dropped, nothing added", () => {
    const w = world();
    const extra = as("alice", () => w.s.create({ title: "unrelated", body: "zebra" })).id;
    const hits = [w.old, extra, w.neu].map((id, i) => ({ note: rec(w.s, id), score: 2 - i * 0.3 }));
    const r = rankHits(w.s, hits, stalenessConfig());
    assert.deepEqual([...ids(r)].sort(), [w.old, extra, w.neu].sort());
    assert.equal(r.length, 3);
    w.s.close();
  });

  test("the order holds over many searches (both notes are read each time), but a note read clearly more keeps its place", async () => {
    const w = world();
    for (let i = 0; i < 15; i++) {
      const r = await runSearch(w.s, "quarzo build server", { mode: "keyword" });
      assert.deepEqual(ids(r).slice(0, 2), [w.neu, w.old], `search ${i + 1}`);
    }
    w.s.flushAccess();
    w.s.captureDb().prepare("UPDATE notes SET access_count = 0, last_accessed = NULL WHERE id = ?").run(w.neu);
    w.s.captureDb().prepare("UPDATE notes SET access_count = 30, last_accessed = ? WHERE id = ?").run(new Date().toISOString(), w.old);
    assert.deepEqual(ids(rank(w)), [w.old, w.neu], "the old note is the one people keep reading");
    w.s.close();
  });

  test("search, explain and the relevance lookup all carry it", async () => {
    const w = world();
    const s1 = (await runSearch(w.s, "quarzo build server", { mode: "keyword" })) as RestatedNote[];
    assert.deepEqual(ids(s1).slice(0, 2), [w.neu, w.old]);
    assert.equal(s1[1].restated_by, w.neu);
    const ex = await runSearchExplained(w.s, "quarzo build server", { mode: "keyword" });
    assert.match(ex[1].breakdown.explanation, /Kept behind #\d+, a newer note by the same writer on the same subject\. Not replaced/);
    const rel = (await runRelevantSearch(w.s, "which build server does quarzo use?")).results as RestatedNote[];
    assert.deepEqual(ids(rel).slice(0, 2), [w.neu, w.old]);
    w.s.close();
  });
});
