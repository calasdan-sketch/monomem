import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads
// Passage pooling (PLAN D/I, opt-in): off by default and then search is unchanged; on, long notes are also searched by their
// best passage, the side index follows writes, and encrypted stores never get an on-disk passage index.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { runSearch } from "../src/search-service.js";
import { passagesOf, passageHits, passageCount, passagePoolingOn, dropPassages, PASSAGE_SETTING, PASSAGE_CHARS } from "../src/store/passages.js";

const mk = { skipEdges: true, lint: "none" } as const;
const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join("\n");

function fill(s: Store): number {
  // A long chat-shaped note whose two query words sit in one passage, and one whose words are far apart.
  const near = s.create({ title: "s1", body: lines(20, (i) => (i === 10 ? "user: the kayak trip to Lake Opal was great" : `user: filler line ${i} about groceries`)) }, mk);
  s.create({ title: "s2", body: lines(20, (i) => (i === 0 ? "user: a kayak" : i === 19 ? "assistant: opal rings" : `assistant: other words ${i}`)) }, mk);
  s.create({ title: "s3", body: "short note on kayak storage" }, mk);
  return near.id;
}

describe("passagesOf", () => {
  test("short bodies are one passage; longer ones are 3-line windows every 2 lines; long lines are cut", () => {
    assert.deepEqual(passagesOf("a\nb"), ["a\nb"]);
    assert.deepEqual(passagesOf(""), []);
    assert.deepEqual(passagesOf("1\n2\n3\n4\n5\n6\n7"), ["1\n2\n3", "3\n4\n5", "5\n6\n7"]);
    assert.deepEqual(passagesOf("1\n2\n3\n4"), ["1\n2\n3", "3\n4"]);
    const long = "word ".repeat(400).trim(); // 1999 characters, one line
    const parts = passagesOf(long);
    assert.ok(parts.length >= 1);
    for (const p of parts) for (const l of p.split("\n")) assert.ok(l.length <= PASSAGE_CHARS);
  });
});

describe("passage pooling switch", () => {
  test("off by default: no side table, search results identical", async () => {
    const s = new Store(":memory:");
    try {
      fill(s);
      assert.equal(passagePoolingOn(s), false);
      const before = (await runSearch(s, "kayak opal", { mode: "keyword" })).map((n) => n.id);
      assert.equal(passageCount(s), 0);
      assert.equal(s.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'passages_fts'").get(), undefined);
      const again = (await runSearch(s, "kayak opal", { mode: "keyword" })).map((n) => n.id);
      assert.deepEqual(again, before);
    } finally {
      s.close();
    }
  });

  test("on: the best passage ranks the note whose words sit together; writes and archive are followed", async () => {
    const s = new Store(":memory:");
    try {
      const near = fill(s);
      s.setMeta(PASSAGE_SETTING, "on");
      assert.equal(passagePoolingOn(s), true);
      const hits = passageHits(s, "kayak opal", 10);
      assert.equal(hits[0].note.id, near);
      assert.ok(passageCount(s) > 0);
      const res = await runSearch(s, "kayak opal", { mode: "keyword" });
      assert.ok(res.some((n) => n.id === near));
      // A later write is caught up from change_log before the next pooled search.
      const late = s.create({ title: "s4", body: lines(10, (i) => (i === 5 ? "user: zeppelin kayak" : `user: x ${i}`)) }, mk);
      assert.ok(passageHits(s, "zeppelin", 10).some((h) => h.note.id === late.id));
      s.update(late.id, { body: "user: nothing here now" });
      assert.equal(passageHits(s, "zeppelin", 10).length, 0);
      s.archive(near);
      assert.ok(!passageHits(s, "kayak opal", 10).some((h) => h.note.id === near));
      // Namespace filter is the same as whole-note search.
      assert.equal(passageHits(s, "kayak", 10, { namespace: "elsewhere" }).length, 0);
      dropPassages(s);
      assert.equal(passageCount(s), 0);
    } finally {
      s.close();
    }
  });

  test("encrypted store: pooling stays off and no passage index is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-pp-enc-"));
    try {
      ensureKey(dir);
      const s = new Store(join(dir, "state.db"));
      try {
        fill(s);
        s.setMeta(PASSAGE_SETTING, "on");
        assert.equal(passagePoolingOn(s), false);
        await runSearch(s, "kayak opal", { mode: "keyword" });
        assert.equal(passageCount(s), 0);
      } finally {
        s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("monomem settings set passage_pooling", () => {
  test("on builds the index and says so; off removes it; bad values and encrypted stores are refused", async () => {
    const { setPassagePooling, passagePoolingLine } = await import("../src/cli/passages.js");
    const s = new Store(":memory:");
    try {
      fill(s);
      assert.match(passagePoolingLine(s), /passage-pooling: off \(default\)/);
      assert.match(setPassagePooling(s, "on"), /passages indexed/);
      assert.ok(passageCount(s) > 0);
      assert.match(passagePoolingLine(s), /passage-pooling: on$/);
      assert.match(setPassagePooling(s, "off"), /off/);
      assert.equal(passageCount(s), 0);
      assert.equal(passagePoolingOn(s), false);
      assert.throws(() => setPassagePooling(s, "yes"), /on or off/);
    } finally {
      s.close();
    }
    const dir = mkdtempSync(join(tmpdir(), "om-pp-enc2-"));
    try {
      ensureKey(dir);
      const e = new Store(join(dir, "state.db"));
      try {
        assert.throws(() => setPassagePooling(e, "on"), /encrypted/);
      } finally {
        e.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
