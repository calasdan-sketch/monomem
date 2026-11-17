import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads
// F4 BLOCKER (Node 26): a DELETE from an FTS5 contentless_delete table leaves sqlite3_last_insert_rowid() above 2^53.
// node:sqlite reads it after every run(): Node 26 throws "Value is too large to be represented as a JavaScript number"
// (Node 24 silently returns a wrong number), and every later run() on that connection does the same until an insert
// resets it. Both side indexes (passages_fts, the encrypted in-memory body index) now delete inside TEMP triggers, so the
// connection's last rowid comes back as it was. These tests fail on any Node when the rowid leaks (Number.isSafeInteger).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { runSearch } from "../src/search-service.js";
import { passageHits, syncPassages, PASSAGE_SETTING } from "../src/store/passages.js";

const mk = { skipEdges: true, lint: "none" } as const;
const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join("\n");

/** The connection's last rowid as node:sqlite reports it after a plain write: must be a safe integer. */
function lastRowidSafe(s: Store, what: string): void {
  const r = s.db.prepare("UPDATE _meta SET value = value WHERE key = 'nothing-here'").run();
  assert.ok(Number.isSafeInteger(Number(r.lastInsertRowid)) && typeof r.lastInsertRowid === "number", `${what}: last rowid ${r.lastInsertRowid} is a safe number`);
}

async function withDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "om-f4-rowid-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("FTS writes are safe on Node 26 (last rowid above 2^53)", () => {
  test("pooling on: edit, search, archive, delete, and every later write on the connection still works", async () =>
    withDir(async (dir) => {
      const s = new Store(join(dir, "state.db"));
      try {
        s.setMeta(PASSAGE_SETTING, "on");
        const made = Array.from({ length: 30 }, (_, k) =>
          s.create({ title: `n${k}`, body: lines(12, (i) => (i === 4 ? `user: kayak trip number ${k} to opal lake` : `user: filler ${k}-${i}`)) }, mk)
        );
        assert.ok(passageHits(s, "kayak", 50).length >= 30, "all passages indexed");
        lastRowidSafe(s, "after the build");
        // Edit: the old passages are deleted, new ones written.
        s.update(made[0].id, { body: lines(8, (i) => (i === 2 ? "user: zeppelin ride" : `user: other ${i}`)) });
        assert.equal(syncPassages(s), true, "sync after an edit succeeds");
        assert.deepEqual(passageHits(s, "zeppelin", 10).map((h) => h.note.id), [made[0].id]);
        lastRowidSafe(s, "after an edit was synced");
        // Archive, delete: their passages go; later writes on the same connection work.
        s.archive(made[1].id);
        s.delete(made[2].id);
        assert.equal(syncPassages(s), true, "sync after archive and delete succeeds");
        lastRowidSafe(s, "after a delete was synced");
        const hits = passageHits(s, "kayak", 50).map((h) => h.note.id);
        assert.ok(!hits.includes(made[1].id) && !hits.includes(made[2].id) && !hits.includes(made[0].id));
        s.update(made[3].id, { body: "user: plain words now" }); // threw on Node 26 before the fix
        s.archive(made[4].id);
        const res = await runSearch(s, "zeppelin", { mode: "keyword" });
        assert.deepEqual(res.map((n) => n.id), [made[0].id]);
        assert.ok(!passageHits(s, "kayak", 50).some((h) => h.note.id === made[3].id), "an edit after a delete is followed");
      } finally {
        s.close();
      }
    }));

  test("a failed passage sync is not searched: syncPassages returns false and the stale index is skipped", () =>
    withDir((dir) => {
      const s = new Store(join(dir, "state.db"));
      try {
        s.setMeta(PASSAGE_SETTING, "on");
        const n = s.create({ title: "a", body: lines(6, (i) => (i === 1 ? "user: quokka" : `user: x ${i}`)) }, mk);
        assert.equal(passageHits(s, "quokka", 5).length, 1);
        s.update(n.id, { body: "user: wombat" });
        // Break the next replay: the change_log row points at our note, but the passage table cannot be written.
        const orig = s.beginWrite.bind(s);
        s.beginWrite = () => {
          throw new Error("disk is full");
        };
        const err = process.stderr.write;
        process.stderr.write = () => true;
        try {
          assert.equal(syncPassages(s), false, "a failed sync says there is nothing current to search");
          assert.equal(passageHits(s, "quokka", 5).length, 0, "the old words are not served from the stale index");
        } finally {
          process.stderr.write = err;
          s.beginWrite = orig;
        }
        assert.deepEqual(passageHits(s, "wombat", 5).map((h) => h.note.id), [n.id], "the next search catches up");
      } finally {
        s.close();
      }
    }));

  test("encrypted store: a second process edits several notes; the next search finds them with no rebuild", () =>
    withDir((dir) => {
      ensureKey(dir);
      const db = join(dir, "state.db");
      const s = new Store(db);
      try {
        const ids = Array.from({ length: 40 }, (_, k) => s.create({ title: `t${k}`, body: `body words gerbil number${k}`, tags: [] }, mk).id);
        assert.equal(s.searchRanked("gerbil", { anyTerm: true, limit: 100 }).length, 40);
        const builds = s.bodyIndexInfo().builds;
        const falls = s.bodyIndexInfo().fallbacks;
        const storeUrl = pathToFileURL(resolve(import.meta.dirname, "../src/store.js")).href;
        const script = `import { Store } from ${JSON.stringify(storeUrl)};
          const s = new Store(${JSON.stringify(db)}, { bodyIndex: "off" });
          for (const id of ${JSON.stringify(ids.slice(0, 5))}) s.update(id, { body: "now a capybara swims " + id });
          s.delete(${ids[5]});
          s.close();`;
        const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: process.env });
        assert.equal(r.status, 0, r.stderr);
        const found = s.searchRanked("capybara", { anyTerm: true, limit: 100 }).map((h) => h.note.id).sort((a, b) => a - b);
        assert.deepEqual(found, ids.slice(0, 5), "the other process's edits are found");
        assert.equal(s.searchRanked("gerbil", { anyTerm: true, limit: 100 }).length, 34, "old words and the deleted note are gone");
        assert.equal(s.bodyIndexInfo().builds, builds, "caught up from the change log, no full rebuild");
        assert.equal(s.bodyIndexInfo().fallbacks, falls, "no search fell back to titles and tags");
        lastRowidSafe(s, "after the catch-up");
        s.update(ids[6], { body: "plain again" }); // a write on the same connection after the catch-up
      } finally {
        s.close();
      }
    }));
});
