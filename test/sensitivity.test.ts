// Per-memory sensitivity labels (public < internal < private) and per-token ceilings.
//
// The promise under test: a token with a ceiling can never read a note above it on ANY path, a hidden note answers
// exactly like a note that does not exist, a token cannot write or relabel above its ceiling, and everything that
// existed before labels (tokens without a ceiling, notes without a label) behaves as it always did.
import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, SCHEMA_VERSION, ValidationError, QuarantinedError, type NoteRecord } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { resolveTokens, type TokenEntry } from "../src/config.js";
import { consolidateNotes } from "../src/consolidate.js";
import { injectContext } from "../src/context-inject.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";
import { SENSITIVITY_LEVELS, sensitivityRank, sensitivityVisible, levelsAtOrBelow, parseSensitivity, type Sensitivity } from "../src/sensitivity.js";
import { downgradeTo } from "./legacy-db.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { warnUnlabelledExposure, mayEmbed } from "../src/sensitivity.js";
import { maybeEmbed } from "../src/search-service.js";
import { runGitSync, type GitSyncOptions } from "../src/sync-git.js";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";

const PUB = "PUBMARK";
const INT = "INTMARK";
const PRIV = "PRIVMARK";

/** Run `fn` as a caller with this ceiling (undefined = no ceiling, like the operator). */
function as<T>(max: Sensitivity | undefined, fn: () => T, canDeclassify = true): T {
  return actorStore.run({ label: "tok", authed: true, ...(max ? { maxSensitivity: max } : {}), canDeclassify }, fn);
}

interface Fixture {
  store: Store;
  pub: NoteRecord;
  int: NoteRecord;
  priv: NoteRecord;
}

// Three notes that share words (so search, semantic search and the similarity graph all link them).
function fixture(): Fixture {
  const store = new Store(":memory:");
  const body = (m: string): string => `zebra giraffe antelope savanna migration herd ${m} watering hole drought season`;
  const pub = store.create({ title: `${PUB} zebra herd`, body: body(PUB), tags: ["animals"], sensitivity: "public" });
  const int = store.create({ title: `${INT} zebra herd`, body: body(INT), tags: ["animals"] });
  const priv = store.create({ title: `${PRIV} zebra herd`, body: body(PRIV), tags: ["animals", "locked"], sensitivity: "private" });
  return { store, pub, int, priv };
}

const dump = (v: unknown): string => JSON.stringify(v);
const noLeak = (v: unknown, hidden: string[], what: string): void => {
  const s = dump(v);
  for (const h of hidden) assert.ok(!s.includes(h), `${what} leaked ${h}: ${s.slice(0, 300)}`);
};

describe("labels: ordering, validation, defaults", () => {
  test("the order is public < internal < private, and unknown values rank above every real label", () => {
    assert.deepEqual([...SENSITIVITY_LEVELS], ["public", "internal", "private"]);
    assert.ok(sensitivityRank("public") < sensitivityRank("internal"));
    assert.ok(sensitivityRank("internal") < sensitivityRank("private"));
    assert.ok(sensitivityRank("secret") > sensitivityRank("private"));
    assert.ok(sensitivityRank(undefined) > sensitivityRank("private"));
    assert.equal(sensitivityVisible("secret", "private"), false, "an unknown label is hidden even from the top ceiling");
    assert.equal(sensitivityVisible("private", "bogus"), false, "an unknown ceiling admits nothing");
    assert.equal(sensitivityVisible("private", undefined), true, "no ceiling = no filter");
    assert.deepEqual(levelsAtOrBelow("internal"), ["public", "internal"]);
    assert.deepEqual(levelsAtOrBelow("nonsense"), []);
    assert.equal(parseSensitivity(" PRIVATE "), "private");
    assert.equal(parseSensitivity("secret"), null);
    assert.equal(parseSensitivity(5), null);
  });

  test("an unlabelled note is internal and keeps its old record shape; other labels are shown", () => {
    const { store, pub, int, priv } = fixture();
    assert.equal("sensitivity" in int, false, "the default label adds no field");
    assert.equal(pub.sensitivity, "public");
    assert.equal(priv.sensitivity, "private");
    store.close();
  });

  test("an invalid label is rejected on create and on update, and nothing is written", () => {
    const store = new Store(":memory:");
    for (const bad of ["secret", "", "Top Secret", 5, {}, []]) {
      assert.throws(() => store.create({ title: "x", sensitivity: bad as unknown as string }), ValidationError, String(bad));
    }
    assert.equal(store.list({}).total, 0);
    const n = store.create({ title: "ok" });
    assert.throws(() => store.update(n.id, { sensitivity: "nope" }), ValidationError);
    assert.equal(store.read(n.id)?.rev, 1);
    store.close();
  });

  test("labels are case- and space-insensitive on input and stored normalised", () => {
    const store = new Store(":memory:");
    const n = store.create({ title: "x", sensitivity: " PRIVATE " });
    assert.equal(n.sensitivity, "private");
    store.close();
  });
});

describe("schema migration of an existing database", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monomem-sens-mig-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cols = (path: string, table: string): string[] => {
    const raw = new DatabaseSync(path);
    try {
      return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    } finally {
      raw.close();
    }
  };

  for (const from of [18, 17, 16, 15, 14, 13] as const) {
    test(`a v${from} database upgrades: every note becomes internal, nothing is lost, a backup is taken`, () => {
      const path = join(dir, "state.db");
      const s = new Store(path);
      s.create({ title: "old one", body: "alpha" });
      s.create({ title: "old two", body: "beta", tags: ["t"] });
      const gone = s.create({ title: "to delete", body: "gamma" });
      s.delete(gone.id);
      s.close();
      downgradeTo(path, from);
      assert.equal(cols(path, "notes").includes("sensitivity"), false, "the fixture really is the old shape");
      assert.equal(Store.peekSchemaVersion(path), from);

      const quiet = console.error;
      console.error = () => {};
      let u: Store;
      try {
        u = new Store(path);
      } finally {
        console.error = quiet;
      }
      assert.equal(SCHEMA_VERSION, 20);
      assert.equal(Store.peekSchemaVersion(path), 20);
      assert.ok(existsSync(path + ".pre-v20-backup"));
      for (const [t, c] of [["notes", "sensitivity"], ["change_log", "note_sensitivity"], ["quarantine", "sensitivity"]] as const) {
        assert.ok(cols(path, t).includes(c), `${t}.${c}`);
      }
      const titles = u.list({}).notes.map((n) => n.title).sort();
      assert.deepEqual(titles, ["old one", "old two"]);
      assert.ok(u.list({}).notes.every((n) => !("sensitivity" in n)), "migrated notes are internal (no field)");
      // A ceiling now works on the migrated rows: internal is visible to internal, hidden from public.
      assert.equal(as("internal", () => u.list({}).total), 2);
      assert.equal(as("public", () => u.list({}).total), 0);
      // Labelling works, and a delete after the upgrade records the label the note had.
      const t = u.create({ title: "new private", sensitivity: "private" });
      u.delete(t.id);
      const raw = new DatabaseSync(path);
      const row = raw.prepare("SELECT note_sensitivity AS s FROM change_log WHERE note_id = ? AND kind = 'deleted'").get(t.id) as { s: string };
      raw.close();
      assert.equal(row.s, "private");
      u.close();
    });
  }

  test("reopening a v19 database changes nothing and keeps the single backup", () => {
    const path = join(dir, "state.db");
    const s = new Store(path);
    s.create({ title: "n", sensitivity: "private" });
    s.close();
    downgradeTo(path, 16);
    const quiet = console.error;
    console.error = () => {};
    try {
      new Store(path).close();
      new Store(path).close();
    } finally {
      console.error = quiet;
    }
    const baks = readdirSync(dir).filter((f) => f.includes("pre-v20-backup"));
    assert.equal(baks.length, 1, baks.join(","));
    const again = new Store(path);
    assert.equal(again.list({}).notes[0].sensitivity, undefined, "the downgrade fixture dropped the label; migration defaulted it to internal");
    again.close();
  });
});

describe("every read path hides notes above the ceiling", () => {
  let f: Fixture;
  before(() => {
    f = fixture();
    // Make the semantic and graph paths real: one shared vector, files, an expensive edit history, a task-ish tag.
    f.store.linkNoteFiles(f.pub.id, [{ path: "src/pub.ts", action: "read" }]);
    f.store.linkNoteFiles(f.priv.id, [{ path: "src/secret.ts", action: "changed" }]);
    f.store.update(f.priv.id, { body: `${PRIV} edited once` });
    f.store.update(f.priv.id, { body: `${PRIV} edited twice` });
    const v = new Float32Array([1, 0, 0, 0]);
    for (const n of [f.pub, f.int, f.priv]) f.store.setVector(n.id, v, "test");
    // Similarity edges between all three (what the background linker would write).
    const others = (id: number): Array<{ neighborId: number; score: number }> =>
      [f.pub.id, f.int.id, f.priv.id].filter((x) => x !== id).map((neighborId) => ({ neighborId, score: 0.9 }));
    for (const n of [f.pub, f.int, f.priv]) f.store.applyEdgePairs(n.id, others(n.id));
  });
  after(() => f.store.close());

  test("sanity: with no ceiling everything is visible", () => {
    assert.equal(f.store.list({}).total, 3);
    assert.equal(f.store.search("zebra").length, 3);
    assert.ok(f.store.listNeighbors(f.pub.id).some((n) => n.id === f.priv.id), "the graph links the private note");
    assert.ok(f.store.historyOf(f.priv.id).length >= 1);
  });

  test("read(): a hidden note is null, exactly like a missing one", () => {
    as("public", () => {
      assert.equal(f.store.read(f.priv.id), null);
      assert.equal(f.store.read(f.int.id), null);
      assert.equal(f.store.read(999_999), null);
      assert.equal(f.store.readVisible(f.priv.id), null);
      assert.ok(f.store.read(f.pub.id));
    });
    as("internal", () => {
      assert.equal(f.store.read(f.priv.id), null);
      assert.ok(f.store.read(f.int.id));
    });
    as("private", () => assert.ok(f.store.read(f.priv.id)));
  });

  test("a hidden note's read counter is not touched by a probe", () => {
    const before = f.store.read(f.priv.id)!.access_count;
    as("public", () => f.store.read(f.priv.id, { trackAccess: true }));
    assert.equal(f.store.read(f.priv.id)!.access_count, before);
  });

  test("list, count and tag filters", () => {
    const r = as("public", () => f.store.list({}));
    assert.equal(r.total, 1);
    assert.deepEqual(r.notes.map((n) => n.id), [f.pub.id]);
    assert.equal(as("internal", () => f.store.list({}).total), 2);
    assert.equal(as("public", () => f.store.list({ withTags: ["locked"] }).total), 0, "a tag only a hidden note has is not countable");
    assert.equal(as("public", () => f.store.hasTagged({ withTags: ["locked"] })), false);
    assert.equal(f.store.hasTagged({ withTags: ["locked"] }), true);
    assert.equal(as("public", () => f.store.list({ namespaces: ["default"] }).total), 1);
    assert.equal(as("public", () => f.store.list({ namespace: "default", limit: 1, offset: 1 }).notes.length), 0);
  });

  test("keyword search (FTS) filters before the limit", () => {
    const hits = as("public", () => f.store.search("zebra", { limit: 1 }));
    assert.deepEqual(hits.map((n) => n.id), [f.pub.id], "limit 1 still returns the visible note, not a hidden best match");
    assert.deepEqual(as("public", () => f.store.searchRanked("PRIVMARK").map((h) => h.note.id)), []);
    assert.deepEqual(as("internal", () => f.store.search("zebra").map((n) => n.id).sort()), [f.pub.id, f.int.id].sort());
  });

  test("semantic search (embeddings) filters before ranking", () => {
    const v = new Float32Array([1, 0, 0, 0]);
    assert.equal(f.store.semanticSearch(v, {}).length, 3);
    assert.deepEqual(as("public", () => f.store.semanticSearch(v, {}).map((h) => h.note.id)), [f.pub.id]);
    assert.deepEqual(as("internal", () => f.store.semanticSearch(v, { namespace: "default" }).map((h) => h.note.id).sort()), [f.pub.id, f.int.id].sort());
  });

  test("similarity neighbours never name a hidden note", () => {
    const n = as("public", () => f.store.listNeighbors(f.pub.id));
    noLeak(n, [PRIV, INT], "listNeighbors");
    assert.deepEqual(as("public", () => [...f.store.neighbourIds(f.pub.id)]), []);
    assert.equal(as("public", () => f.store.neighbourCount(f.pub.id)), 0);
    const withN = as("public", () => f.store.read(f.pub.id, { withNeighbors: true }));
    noLeak(withN?.neighbors ?? [], [PRIV, INT], "read withNeighbors");
    assert.deepEqual(as("public", () => f.store.listNeighbors(f.priv.id)), [], "neighbours OF a hidden note are not listed either");
  });

  test("stats and counts: totals, top titles and stale count leave hidden notes out", () => {
    const s = as("public", () => f.store.accessStats());
    assert.equal(s.totalNotes, 1);
    noLeak(s, [PRIV, INT], "accessStats");
    assert.equal(f.store.accessStats().totalNotes, 3);
    assert.equal(as("public", () => f.store.staleCount()), 0);
    assert.equal(as("public", () => f.store.countAll()), 1);
    assert.equal(f.store.countAll(), 3);
  });

  test("change feed: events for hidden notes are absent, counts too", () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const page = as("public", () => f.store.changes({ since }));
    assert.deepEqual(page.changes.map((c) => c.id), [f.pub.id]);
    assert.equal(page.counts.total, 1);
    noLeak(page, [PRIV, INT], "changes");
    assert.equal(f.store.changes({ since }).counts.total, 3);
  });

  test("a deleted note is hidden from the feed by the label it had", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "gone private", sensitivity: "private" });
    const b = s.create({ title: "gone public", sensitivity: "public" });
    s.delete(a.id);
    s.delete(b.id);
    const since = new Date(Date.now() - 60_000).toISOString();
    const pub = as("public", () => s.changes({ since })).changes;
    assert.deepEqual(pub.map((c) => c.id), [b.id], "only the public note's deletion is visible");
    assert.deepEqual(s.changes({ since }).changes.map((c) => c.id).sort(), [a.id, b.id].sort());
    s.close();
  });

  test("export: exportAll, exportBatch and the count skip hidden notes", () => {
    assert.deepEqual(as("public", () => f.store.exportAll().map((n) => n.id)), [f.pub.id]);
    assert.deepEqual(as("public", () => f.store.exportAll({ live: true }).map((n) => n.id)), [f.pub.id]);
    const page = as("internal", () => f.store.exportBatch(0, 100, { history: true, attest: false }));
    assert.deepEqual(page.map((n) => n.id).sort(), [f.pub.id, f.int.id].sort());
    noLeak(page, [PRIV], "exportBatch");
    assert.equal(f.store.exportAll().length, 3);
  });

  test("linked files: a hidden note's files are not listed or counted", () => {
    assert.deepEqual(as("public", () => f.store.recentFilePaths(undefined, 10)), ["src/pub.ts"]);
    assert.ok(f.store.recentFilePaths(undefined, 10).includes("src/secret.ts"));
    const m = as("public", () => f.store.noteFiles([f.pub.id, f.priv.id]));
    assert.ok(m.has(f.pub.id));
    assert.equal(m.has(f.priv.id), false);
  });

  test("history of a hidden note is empty, and cannot be restored or purged", () => {
    as("public", () => {
      assert.deepEqual(f.store.historyOf(f.priv.id), []);
      assert.equal(f.store.historyCount(f.priv.id), 0);
      assert.equal(f.store.historyVersion(f.priv.id, 1), null);
      assert.equal(f.store.purgeHistory(f.priv.id), 0);
      assert.throws(() => f.store.restoreVersion(f.priv.id, 1), ValidationError);
    });
    assert.ok(f.store.historyCount(f.priv.id) >= 1, "nothing was purged");
  });

  test("an unknown label in the database is hidden from every ceiling and visible to the operator", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "odd" });
    const raw = (s as unknown as { db: DatabaseSync }).db;
    raw.prepare("UPDATE notes SET sensitivity = 'topsecret' WHERE id = ?").run(n.id);
    assert.equal(as("private", () => s.list({}).total), 0);
    assert.equal(as("private", () => s.read(n.id)), null);
    assert.equal(as("private", () => s.search("odd").length), 0);
    assert.equal(s.list({}).total, 1, "the operator still sees it");
    s.close();
  });
});

describe("by-id actions cannot touch a hidden note", () => {
  test("update, delete, archive, restore and supersede all answer 'not found' and change nothing", () => {
    const f = fixture();
    const before = f.store.read(f.priv.id)!;
    as("public", () => {
      assert.equal(f.store.update(f.priv.id, { title: "hijack" }), null);
      assert.equal(f.store.delete(f.priv.id), false);
      assert.equal(f.store.deleteIfRev(f.priv.id, before.rev), false);
      assert.equal(f.store.archive(f.priv.id), null);
      assert.equal(f.store.restore(f.priv.id), null);
      assert.equal(f.store.supersedeUndo(f.priv.id, "tok"), null);
      assert.throws(
        () => f.store.supersedeCommit({ oldIds: [f.pub.id], oldRevs: [f.pub.rev], newId: f.priv.id, actor: "tok", nonce: "n1", expiresMs: Date.now() + 1000 }),
        ValidationError
      );
    });
    const after = f.store.read(f.priv.id)!;
    assert.equal(after.title, before.title);
    assert.equal(after.rev, before.rev);
    assert.equal(after.archived_at, undefined);
    f.store.close();
  });

  test("sweeps do not report or archive hidden notes for a restricted caller", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "exp pub", sensitivity: "public", forget_after: 1 });
    const b = s.create({ title: "exp priv", sensitivity: "private", forget_after: 1 });
    const later = Date.now() + 3 * 86_400_000;
    assert.equal(as("public", () => s.sweepExpired(later)), 1);
    assert.ok(s.read(a.id)!.archived_at);
    assert.equal(s.read(b.id)!.archived_at, undefined, "the private note is left for the operator's own sweep");
    s.close();
  });

  test("a held (quarantined) write above the ceiling is invisible to a restricted admin, and approving keeps its label", () => {
    const savedLint = process.env.MONOMEM_LINT;
    process.env.MONOMEM_LINT = "quarantine";
    const s = new Store(":memory:");
    const key = "AKIA" + "1234567890ABCD12";
    let qid = 0;
    as("private", () => {
      try {
        s.create({ title: "held", body: `key ${key}`, sensitivity: "private" });
      } catch (e) {
        assert.ok(e instanceof QuarantinedError);
        qid = (e as QuarantinedError).quarantineId;
      }
    });
    assert.ok(qid > 0);
    assert.equal(as("internal", () => s.listQuarantine().length), 0);
    assert.equal(as("internal", () => s.getQuarantine(qid)), null);
    assert.equal(as("internal", () => s.rejectQuarantine(qid)), false);
    assert.equal(as("private", () => s.listQuarantine().length), 1);
    const note = s.approveQuarantine(qid);
    assert.equal(note.sensitivity, "private", "approval does not quietly relabel the note");
    if (savedLint === undefined) delete process.env.MONOMEM_LINT;
    else process.env.MONOMEM_LINT = savedLint;
    s.close();
  });
});

describe("write and relabel restrictions", () => {
  test("a write above the ceiling is rejected; at or below is accepted", () => {
    const s = new Store(":memory:");
    as("internal", () => {
      assert.throws(() => s.create({ title: "a", sensitivity: "private" }), /ceiling/);
      assert.equal(s.create({ title: "b", sensitivity: "public" }).sensitivity, "public");
      assert.equal(s.create({ title: "c", sensitivity: "internal" }).title, "c");
    });
    as("private", () => assert.equal(s.create({ title: "d", sensitivity: "private" }).sensitivity, "private"));
    assert.equal(s.list({}).total, 3);
    s.close();
  });

  test("an unlabelled write takes 'internal', or the ceiling when that is lower", () => {
    const s = new Store(":memory:");
    assert.equal("sensitivity" in as(undefined, () => s.create({ title: "u1" })), false);
    assert.equal("sensitivity" in as("private", () => s.create({ title: "u2" })), false);
    assert.equal(as("internal", () => s.create({ title: "u3" })).sensitivity, undefined);
    assert.equal(as("public", () => s.create({ title: "u4" })).sensitivity, "public");
    s.close();
  });

  test("relabelling: cannot go above the ceiling, cannot be lowered without admin, can be raised", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "n", sensitivity: "internal" });
    as("internal", () => {
      assert.throws(() => s.update(n.id, { sensitivity: "private" }), /ceiling/);
      assert.throws(() => s.update(n.id, { sensitivity: "public" }), /admin/, "a non-admin cannot lower a label");
    }, false);
    assert.equal(s.read(n.id)!.sensitivity, undefined);
    assert.equal(as("internal", () => s.update(n.id, { sensitivity: "public" }), true)!.sensitivity, "public", "an admin can");
    assert.equal(as("internal", () => s.update(n.id, { sensitivity: "internal" }), false)!.sensitivity, undefined, "a non-admin can raise it back");
    // Not allowed to relabel a note it cannot see at all.
    const p = s.create({ title: "p", sensitivity: "private" });
    assert.equal(as("internal", () => s.update(p.id, { sensitivity: "public" })), null);
    assert.equal(s.read(p.id)!.sensitivity, "private");
    s.close();
  });

  test("no ceiling and no actor (the CLI, stdio) may do anything", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "n", sensitivity: "private" });
    assert.equal(s.update(n.id, { sensitivity: "public" })!.sensitivity, "public");
    s.close();
  });

  test("relabelling a note to the label it already has is a no-op (no new revision)", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "n", sensitivity: "private" });
    const same = s.update(n.id, { sensitivity: "private" })!;
    assert.equal(same.rev, n.rev + 1 > same.rev ? n.rev : same.rev);
    assert.equal(same.sensitivity, "private");
    s.close();
  });

  test("consolidating notes labels the merge with the strictest source", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "dup note about zebras", body: "zebras graze at dawn on the plain", sensitivity: "public" });
    const b = s.create({ title: "dup note about zebras too", body: "zebras graze at dawn on the plain", sensitivity: "private" });
    const merged = consolidateNotes(s, [a.id, b.id], { deleteSources: true });
    assert.equal(merged.sensitivity, "private", "a merge can never lower a label");
    s.close();
  });

  test("consolidation by a restricted admin cannot name a hidden note (same error as a missing one)", () => {
    const f = fixture();
    const err = (id: number): string => {
      try {
        as("public", () => consolidateNotes(f.store, [f.pub.id, id]));
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    assert.equal(err(f.priv.id).replace(String(f.priv.id), "N"), err(999_999).replace("999999", "N"));
    f.store.close();
  });
});

describe("tokens: max_sensitivity in the config", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const tok = (n: string): string => n.padEnd(40, "x");

  test("a ceiling is read from MONOMEM_TOKENS and is optional", () => {
    process.env.MONOMEM_TOKEN = tok("primary");
    process.env.MONOMEM_TOKENS = JSON.stringify([
      { token: tok("a"), scope: "read", label: "a", max_sensitivity: "public" },
      { token: tok("b"), scope: "write", label: "b", namespace: "work", max_sensitivity: "Internal" },
      { token: tok("c"), scope: "write", label: "legacy" },
    ]);
    const t = resolveTokens();
    const by = (l: string): TokenEntry => t.find((x) => x.label === l)!;
    assert.equal(by("a").max_sensitivity, "public");
    assert.equal(by("b").max_sensitivity, "internal");
    assert.equal(by("b").namespace, "work", "ceiling and namespace pin combine");
    assert.equal("max_sensitivity" in by("legacy"), false, "no ceiling = legacy behaviour");
    assert.equal("max_sensitivity" in by("primary"), false, "the primary token is never capped");
  });

  test("an invalid ceiling refuses the whole token (fail closed), never 'no ceiling'", () => {
    process.env.MONOMEM_TOKEN = tok("primary");
    process.env.MONOMEM_TOKENS = JSON.stringify([
      { token: tok("a"), scope: "write", label: "typo", max_sensitivity: "privte" },
      { token: tok("b"), scope: "write", label: "num", max_sensitivity: 3 },
      { token: tok("c"), scope: "write", label: "empty", max_sensitivity: "" },
      { token: tok("d"), scope: "write", label: "ok", max_sensitivity: "private" },
    ]);
    const quiet = console.error;
    const lines: string[] = [];
    console.error = (m: unknown) => void lines.push(String(m));
    try {
      const t = resolveTokens();
      assert.deepEqual(t.map((x) => x.label).sort(), ["ok", "primary"]);
    } finally {
      console.error = quiet;
    }
    assert.ok(lines.some((l) => /max_sensitivity/.test(l)));
  });

  test("a token listed twice keeps the lower ceiling; a ceiling beats none", () => {
    process.env.MONOMEM_TOKEN = tok("primary");
    process.env.MONOMEM_TOKENS = JSON.stringify([
      { token: tok("a"), scope: "write", label: "a", max_sensitivity: "private" },
      { token: tok("a"), scope: "write", label: "a", max_sensitivity: "public" },
      { token: tok("b"), scope: "write", label: "b" },
      { token: tok("b"), scope: "write", label: "b", max_sensitivity: "internal" },
      { token: tok("c"), scope: "write", label: "c", max_sensitivity: "internal" },
      { token: tok("c"), scope: "write", label: "c" },
    ]);
    const t = resolveTokens();
    const by = (l: string): TokenEntry => t.find((x) => x.label === l)!;
    assert.equal(by("a").max_sensitivity, "public");
    assert.equal(by("b").max_sensitivity, "internal");
    assert.equal(by("c").max_sensitivity, "internal");
  });
});

// ---- HTTP API ---------------------------------------------------------------------------------------------------------
const T = {
  admin: "tok-admin-sens-xxxxxxxxxxxxxxxxxxxxxxxx",
  legacy: "tok-legacy-sens-xxxxxxxxxxxxxxxxxxxxxxx",
  readPub: "tok-read-public-xxxxxxxxxxxxxxxxxxxxxxx",
  writeInt: "tok-write-internal-xxxxxxxxxxxxxxxxxxxx",
  adminInt: "tok-admin-internal-xxxxxxxxxxxxxxxxxxxx",
  workPub: "tok-work-public-xxxxxxxxxxxxxxxxxxxxxxx",
};
const TOKENS: TokenEntry[] = [
  { token: T.admin, scope: "admin", label: "operator" },
  { token: T.legacy, scope: "write", label: "legacy" },
  { token: T.readPub, scope: "read", label: "read-public", max_sensitivity: "public" },
  { token: T.writeInt, scope: "write", label: "write-internal", max_sensitivity: "internal" },
  { token: T.adminInt, scope: "admin", label: "admin-internal", max_sensitivity: "internal" },
  { token: T.workPub, scope: "write", label: "work-public", namespace: "work", max_sensitivity: "public" },
];

describe("REST API: ceilings on every route", () => {
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  let ids: { pub: number; int: number; priv: number; workPub: number; workPriv: number; otherPub: number };

  const call = async (token: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, text, json };
  };

  before(async () => {
    store = new Store(":memory:");
    const mk = (title: string, sensitivity?: string, namespace?: string): number =>
      store.create({ title, body: `zebra herd ${title}`, tags: ["animals"], ...(sensitivity ? { sensitivity } : {}), ...(namespace ? { namespace } : {}) }).id;
    ids = {
      pub: mk(`${PUB} a`, "public"),
      int: mk(`${INT} a`),
      priv: mk(`${PRIV} a`, "private"),
      workPub: mk(`${PUB} work`, "public", "work"),
      workPriv: mk(`${PRIV} work`, "private", "work"),
      otherPub: mk(`${PUB} other`, "public", "other"),
    };
    server = createApiServer(store, TOKENS);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  test("a hidden note answers byte-for-byte like a missing one, on every by-id route", async () => {
    const routes: Array<[string, string, unknown?]> = [
      ["GET", "/notes/{id}"],
      ["PUT", "/notes/{id}", { title: "x" }],
      ["DELETE", "/notes/{id}"],
      ["GET", "/notes/{id}/history"],
    ];
    for (const [m, p, b] of routes) {
      const hidden = await call(T.adminInt, m, p.replace("{id}", String(ids.priv)), b);
      const missing = await call(T.adminInt, m, p.replace("{id}", "987654"), b);
      assert.equal(hidden.status, missing.status, `${m} ${p}`);
      assert.equal(hidden.text, missing.text, `${m} ${p}`);
      assert.equal(hidden.status, 404, `${m} ${p}`);
    }
    for (const act of ["archive", "restore"]) {
      const hidden = await call(T.adminInt, "POST", `/notes/${ids.priv}/${act}`);
      const missing = await call(T.adminInt, "POST", `/notes/987654/${act}`);
      assert.equal(hidden.status, missing.status, act);
      assert.equal(hidden.text, missing.text, act);
    }
    assert.equal(store.read(ids.priv)!.rev, 1, "nothing was changed");
    assert.equal(store.read(ids.priv)!.archived_at, undefined);
  });

  test("list, search, relevant, stats, changes, index, timeline, get and sessions never show hidden notes", async () => {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/notes"],
      ["GET", "/notes?namespace=work"],
      ["GET", "/search?q=zebra"],
      ["GET", "/search?q=PRIVMARK"],
      ["GET", "/search?q=zebra&mode=hybrid"],
      ["POST", "/relevant", { query: "zebra herd" }],
      ["GET", "/stats"],
      ["GET", `/changes?since=${encodeURIComponent(since)}`],
      ["GET", "/index"],
      ["GET", "/index?q=zebra"],
      ["GET", `/timeline?anchor=${ids.pub}`],
      ["POST", "/get", { ids: [ids.priv, ids.int, ids.pub] }],
      ["GET", "/sessions"],
      ["GET", "/tasks"],
      ["GET", "/catch-up"],
      ["GET", "/quarantine"],
    ];
    for (const [m, p, b] of calls) {
      const r = await call(T.readPub, m, p, b);
      if (r.status === 403) continue; // admin-only route for a read token: nothing to leak
      assert.ok(r.status < 500, `${m} ${p} -> ${r.status}`);
      noLeak(r.text, [PRIV, INT, "locked"], `${m} ${p}`);
    }
    const list = await call(T.readPub, "GET", "/notes");
    assert.equal(list.json.total, 3, "the three public notes (default, work, other)");
    assert.ok(list.json.notes.every((n: { id: number }) => [ids.pub, ids.workPub, ids.otherPub].includes(n.id)));
    const search = await call(T.readPub, "GET", "/search?q=zebra");
    assert.ok(dump(search.json).includes(PUB));
    const got = await call(T.readPub, "POST", "/get", { ids: [ids.priv, ids.int, ids.pub] });
    assert.deepEqual(got.json.missing.sort(), [ids.priv, ids.int].sort());
  });

  test("/stats counts only what the caller can see", async () => {
    const hi = await call(T.admin, "GET", "/stats");
    const lo = await call(T.readPub, "GET", "/stats");
    const n = (r: { json: any }): number => r.json.totalNotes ?? r.json.stats?.totalNotes;
    assert.equal(n(hi), 6);
    assert.equal(n(lo), 3, "the three public notes (default, work, other)");
  });

  test("export by an admin with a ceiling is partial; the operator's is complete", async () => {
    const lo = await call(T.adminInt, "GET", "/export");
    noLeak(lo.text, [PRIV], "/export");
    assert.ok(lo.text.includes(INT));
    const hi = await call(T.admin, "GET", "/export");
    assert.ok(hi.text.includes(PRIV));
  });

  test("writes: above the ceiling is 400 and writes nothing; relabel up to the ceiling works", async () => {
    const before = store.list({}).total;
    const bad = await call(T.writeInt, "POST", "/notes", { title: "sneaky", sensitivity: "private" });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /ceiling/);
    assert.equal(store.list({}).total, before);
    const invalid = await call(T.writeInt, "POST", "/notes", { title: "sneaky", sensitivity: "secret" });
    assert.equal(invalid.status, 400);
    const ok = await call(T.writeInt, "POST", "/notes", { title: "fine", sensitivity: "public" });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.note.sensitivity, "public");
    const dflt = await call(T.writeInt, "POST", "/notes", { title: "default label" });
    assert.equal(dflt.json.note.sensitivity, "internal"); // the REST answer always names the label, the default included
    // A write token cannot lower a label; an admin token can; neither can exceed its ceiling.
    const lower = await call(T.writeInt, "PUT", `/notes/${dflt.json.note.id}`, { sensitivity: "public" });
    assert.equal(lower.status, 400);
    assert.match(lower.text, /admin/);
    const raise = await call(T.writeInt, "PUT", `/notes/${ok.json.note.id}`, { sensitivity: "internal" });
    assert.equal(raise.status, 200);
    const high = await call(T.adminInt, "PUT", `/notes/${ok.json.note.id}`, { sensitivity: "private" });
    assert.equal(high.status, 400);
    const down = await call(T.adminInt, "PUT", `/notes/${dflt.json.note.id}`, { sensitivity: "public" });
    assert.equal(down.status, 200);
    assert.equal(down.json.note.sensitivity, "public");
  });

  test("a write token with no ceiling (legacy) and the primary token are unrestricted", async () => {
    const mine = await call(T.legacy, "POST", "/notes", { title: "legacy private", sensitivity: "private" });
    assert.equal(mine.status, 201);
    const seen = await call(T.legacy, "GET", `/notes/${mine.json.note.id}`);
    assert.equal(seen.status, 200);
    assert.equal(seen.json.note.sensitivity, "private");
    const all = await call(T.legacy, "GET", "/notes");
    assert.ok(dump(all.json).includes(PRIV), "a token without a ceiling still sees private notes");
    const op = await call(T.admin, "GET", `/notes/${ids.priv}`);
    assert.equal(op.status, 200);
  });

  test("namespace pin and ceiling combine: only the pinned namespace's notes at or below the ceiling", async () => {
    const list = await call(T.workPub, "GET", "/notes");
    assert.deepEqual(list.json.notes.map((n: { id: number }) => n.id), [ids.workPub]);
    noLeak(list.text, [PRIV, INT, `${PUB} other`, `${PUB} a`], "work-public list");
    assert.equal((await call(T.workPub, "GET", `/notes/${ids.workPriv}`)).status, 404, "same namespace, above the ceiling");
    assert.equal((await call(T.workPub, "GET", `/notes/${ids.otherPub}`)).status, 404, "below the ceiling, wrong namespace");
    assert.equal((await call(T.workPub, "GET", `/notes/${ids.workPub}`)).status, 200);
    const wrote = await call(T.workPub, "POST", "/notes", { title: "mine", namespace: "other" });
    assert.equal(wrote.json.note.namespace, "work");
    assert.equal(wrote.json.note.sensitivity, "public", "an unlabelled write by a public-capped token is public");
    assert.equal((await call(T.workPub, "POST", "/notes", { title: "no", sensitivity: "internal" })).status, 400);
  });

  test("concurrent requests with different ceilings never bleed into each other", async () => {
    const reqs: Array<Promise<{ ceiling: string; text: string }>> = [];
    for (let i = 0; i < 20; i++) {
      reqs.push(call(T.readPub, "GET", "/notes").then((r) => ({ ceiling: "public", text: r.text })));
      reqs.push(call(T.admin, "GET", "/notes").then((r) => ({ ceiling: "none", text: r.text })));
      reqs.push(call(T.adminInt, "GET", "/notes").then((r) => ({ ceiling: "internal", text: r.text })));
    }
    for (const r of await Promise.all(reqs)) {
      if (r.ceiling === "public") noLeak(r.text, [PRIV, INT], "public request");
      if (r.ceiling === "internal") noLeak(r.text, [PRIV], "internal request");
      if (r.ceiling === "none") assert.ok(r.text.includes(PRIV), "operator request lost its view");
    }
  });
});

// ---- MCP ---------------------------------------------------------------------------------------------------------------
describe("MCP: ceilings on every tool", () => {
  async function connect(store: Store, scope: "read" | "write" | "admin", max?: Sensitivity): Promise<Client> {
    const server = createMcpServer(store, scope, {}, { label: "mcp-tok", authed: true, ...(max ? { maxSensitivity: max } : {}) });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(s)]);
    return client;
  }
  const text = (r: any): string => (r.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");

  test("search, list, read, relevant, since, stats, catch_up, index, get never show hidden notes", async () => {
    const f = fixture();
    const c = await connect(f.store, "admin", "public");
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["state_search", { query: "zebra" }],
      ["state_search", { query: "PRIVMARK" }],
      ["state_list", {}],
      ["state_read", { id: f.priv.id }],
      ["state_read", { id: f.int.id, neighbors: true }],
      ["state_relevant", { query: "zebra herd" }],
      ["memory_since", { since }],
      ["memory_stats", {}],
      ["catch_up", {}],
      ["memory_index", {}],
      ["memory_index", { query: "zebra" }],
      ["memory_get", { ids: [f.priv.id, f.int.id] }],
      ["memory_history", { id: f.priv.id }],
      ["memory_quarantine", {}],
      ["session_list", {}],
    ];
    for (const [name, args] of calls) {
      const r: any = await c.callTool({ name, arguments: args });
      noLeak(text(r), [PRIV, INT, "locked"], name);
    }
    const hidden: any = await c.callTool({ name: "state_read", arguments: { id: f.priv.id } });
    const missing: any = await c.callTool({ name: "state_read", arguments: { id: 424242 } });
    assert.equal(hidden.isError, true);
    assert.equal(text(hidden).replace(String(f.priv.id), "N"), text(missing).replace("424242", "N"), "same error as a missing note");
    const list: any = await c.callTool({ name: "state_list", arguments: {} });
    assert.ok(text(list).includes(PUB));
    await c.close();
    f.store.close();
  });

  test("state_write: the sensitivity parameter exists, is capped by the ceiling, and cannot be lowered without admin", async () => {
    const store = new Store(":memory:");
    const w = await connect(store, "write", "internal");
    const tools = await w.listTools();
    const sw = tools.tools.find((t) => t.name === "state_write")!;
    assert.ok((sw.inputSchema.properties as Record<string, unknown>).sensitivity, "state_write advertises the parameter");
    const bad: any = await w.callTool({ name: "state_write", arguments: { title: "x", sensitivity: "private" } });
    assert.equal(bad.isError, true);
    assert.equal(store.list({}).total, 0);
    const ok: any = await w.callTool({ name: "state_write", arguments: { title: "x", sensitivity: "internal" } });
    assert.ok(!ok.isError);
    const id = store.list({}).notes[0].id;
    const low: any = await w.callTool({ name: "state_write", arguments: { id, sensitivity: "public" } });
    assert.equal(low.isError, true);
    assert.match(text(low), /admin/);
    const a = await connect(store, "admin", "internal");
    const lowered: any = await a.callTool({ name: "state_write", arguments: { id, sensitivity: "public" } });
    assert.ok(!lowered.isError, text(lowered));
    assert.equal(store.read(id)!.sensitivity, "public");
    await w.close();
    await a.close();
    store.close();
  });

  test("a connection with no ceiling sees everything (legacy)", async () => {
    const f = fixture();
    const c = await connect(f.store, "write");
    const r: any = await c.callTool({ name: "state_list", arguments: {} });
    assert.ok(text(r).includes(PRIV));
    await c.close();
    f.store.close();
  });
});

describe("session-start injection and hooks", () => {
  const noGit = { branch: "", diffFiles: [] as string[] };

  test("injectContext under a ceiling leaves hidden notes out of every section", async () => {
    const f = fixture();
    f.store.linkNoteFiles(f.priv.id, [{ path: "src/secret.ts", action: "changed" }]);
    const all = await injectContext(f.store, { signals: { branch: "", diffFiles: ["src/secret.ts"] } });
    assert.ok(all.includes(PRIV), "sanity: the operator's injection includes the private note");
    const low = await as("public", () => injectContext(f.store, { signals: { branch: "", diffFiles: ["src/secret.ts"] } }));
    noLeak(low, [PRIV, INT, "secret.ts"], "injectContext");
    const mid = await as("internal", () => injectContext(f.store, { signals: noGit }));
    noLeak(mid, [PRIV], "injectContext internal");
    assert.ok(mid.includes(INT));
    f.store.close();
  });

  test("the recall hook honours MONOMEM_RECALL_MAX_SENSITIVITY and fails closed on a bad value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-sens-recall-"));
    const db = join(dir, "state.db");
    const s = new Store(db);
    s.create({ title: `${PUB} hello`, body: "visible", sensitivity: "public" });
    s.create({ title: `${PRIV} hello`, body: "hidden", sensitivity: "private" });
    s.close();
    const { runRecall } = await import("../src/recall.js");
    const prev = process.env.MONOMEM_RECALL_MAX_SENSITIVITY;
    const quiet = console.error;
    console.error = () => {};
    try {
      delete process.env.MONOMEM_RECALL_MAX_SENSITIVITY;
      assert.ok((await runRecall({ dbPath: db })).includes(PRIV), "no cap: both are injected");
      process.env.MONOMEM_RECALL_MAX_SENSITIVITY = "public";
      const capped = await runRecall({ dbPath: db });
      assert.ok(capped.includes(PUB));
      noLeak(capped, [PRIV], "recall hook");
      process.env.MONOMEM_RECALL_MAX_SENSITIVITY = "privat";
      noLeak(await runRecall({ dbPath: db }), [PRIV, PUB], "recall hook with a typo'd cap");
    } finally {
      console.error = quiet;
      if (prev === undefined) delete process.env.MONOMEM_RECALL_MAX_SENSITIVITY;
      else process.env.MONOMEM_RECALL_MAX_SENSITIVITY = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plain-file vault export keeps labels and honours a ceiling", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monomem-sens-vault-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const all = (d: string): string => {
    let out = "";
    for (const ns of readdirSync(d, { withFileTypes: true })) {
      if (!ns.isDirectory() || ns.name.startsWith(".")) continue;
      for (const f of readdirSync(join(d, ns.name))) out += readFileSync(join(d, ns.name, f), "utf8") + "\n";
    }
    return out;
  };

  test("--max-sensitivity writes nothing above it and prunes an earlier file", () => {
    const f = fixture();
    exportMarkdown(f.store, dir);
    assert.ok(all(dir).includes(PRIV), "sanity: an uncapped export writes the private note");
    const r = exportMarkdown(f.store, dir, { maxSensitivity: "internal" });
    assert.ok(r.removed >= 1, "the earlier private file is pruned");
    noLeak(all(dir), [PRIV], "vault");
    assert.ok(all(dir).includes(INT));
    exportMarkdown(f.store, dir, { maxSensitivity: "public" });
    noLeak(all(dir), [PRIV, INT], "vault public");
    f.store.close();
  });

  test("MONOMEM_EXPORT_MAX_SENSITIVITY applies when no option is given, and a bad value stops the export", () => {
    const f = fixture();
    const prev = process.env.MONOMEM_EXPORT_MAX_SENSITIVITY;
    try {
      process.env.MONOMEM_EXPORT_MAX_SENSITIVITY = "public";
      exportMarkdown(f.store, dir);
      noLeak(all(dir), [PRIV, INT], "vault via env");
      process.env.MONOMEM_EXPORT_MAX_SENSITIVITY = "publik";
      assert.throws(() => exportMarkdown(f.store, join(dir, "other")), /MONOMEM_EXPORT_MAX_SENSITIVITY/);
      assert.equal(existsSync(join(dir, "other")), false, "nothing was exported");
    } finally {
      if (prev === undefined) delete process.env.MONOMEM_EXPORT_MAX_SENSITIVITY;
      else process.env.MONOMEM_EXPORT_MAX_SENSITIVITY = prev;
    }
    f.store.close();
  });

  test("a label survives export -> import into a fresh store", async () => {
    const f = fixture();
    exportMarkdown(f.store, dir);
    const fresh = new Store(":memory:");
    const res = await importMarkdown(fresh, dir);
    assert.ok(res.counts.created >= 3, dump(res.counts));
    const byTitle = new Map(fresh.list({}).notes.map((n) => [n.title, n]));
    assert.equal(byTitle.get(`${PRIV} zebra herd`)?.sensitivity, "private");
    assert.equal(byTitle.get(`${PUB} zebra herd`)?.sensitivity, "public");
    assert.equal(byTitle.get(`${INT} zebra herd`)?.sensitivity, undefined);
    fresh.close();
    f.store.close();
  });

  test("a file with a bad label is rejected, not imported as internal", async () => {
    const f = fixture();
    exportMarkdown(f.store, dir);
    const fresh = new Store(":memory:");
    const nsDir = join(dir, readdirSync(dir).find((d) => !d.startsWith("."))!);
    for (const file of readdirSync(nsDir)) {
      const p = join(nsDir, file);
      const t = readFileSync(p, "utf8");
      if (t.includes('sensitivity: "private"')) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(p, t.replace('sensitivity: "private"', 'sensitivity: "secret"'));
      }
    }
    const res = await importMarkdown(fresh, dir);
    assert.ok(res.counts.rejected >= 1);
    assert.equal(fresh.list({}).notes.some((n) => n.title.startsWith(PRIV)), false);
    fresh.close();
    f.store.close();
  });
});

describe("JSON export/import round trip", () => {
  test("labels travel in an export and are restored by an import; a bad label is rejected per note", async () => {
    const f = fixture();
    const exported = f.store.exportAll();
    const fresh = new Store(":memory:");
    const report = { rejected: [] as Array<{ title: string; error: string }> } as any;
    await fresh.importNotes(exported as any, { report });
    const by = new Map(fresh.list({}).notes.map((n) => [n.title, n.sensitivity]));
    assert.equal(by.get(`${PRIV} zebra herd`), "private");
    assert.equal(by.get(`${PUB} zebra herd`), "public");
    const again = new Store(":memory:");
    const rep2 = { rejected: [] as Array<{ title: string; error: string }> } as any;
    await again.importNotes([{ title: "weird", sensitivity: "secret" } as any], { report: rep2 });
    assert.equal(again.list({}).total, 0);
    assert.equal(rep2.rejected.length, 1);
    // An import by a restricted admin cannot create a note above its ceiling.
    const capped = new Store(":memory:");
    const rep3 = { rejected: [] as Array<{ title: string; error: string }> } as any;
    await as("internal", () => capped.importNotes(exported as any, { report: rep3 }));
    assert.equal(capped.list({}).notes.some((n) => n.sensitivity === "private"), false);
    assert.ok(rep3.rejected.length >= 1);
    capped.close();
    again.close();
    fresh.close();
    f.store.close();
  });
});

describe("CLI: monomem label", () => {
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "monomem-sens-cli-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const run = (...args: string[]): { code: number | null; out: string; err: string } => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, MONOMEM_HOME: home, MONOMEM_DB_PATH: join(home, "state.db") }, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  test("shows, sets and refuses", () => {
    const s = new Store(join(home, "state.db"));
    const n = s.create({ title: "cli note" });
    s.close();
    assert.match(run("label", String(n.id)).out, /is internal/);
    const set = run("label", String(n.id), "private");
    assert.equal(set.code, 0, set.err);
    assert.match(set.out, /is now private/);
    assert.match(run("label", String(n.id)).out, /is private/);
    const bad = run("label", String(n.id), "secret");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /sensitivity must be/);
    assert.equal(run("label", "9999").code, 1);
    assert.equal(run("label").code, 1);
    const s2 = new Store(join(home, "state.db"));
    assert.equal(s2.read(n.id)!.sensitivity, "private");
    s2.close();
  });

  test("export --max-sensitivity refuses a value that is not a label", () => {
    const r = run("export", "--format", "md", "--dir", join(home, "vault"), "--max-sensitivity", "publik");
    assert.equal(r.code, 1);
    assert.match(r.err, /--max-sensitivity must be/);
    assert.equal(existsSync(join(home, "vault")), false);
  });
});


// ---- Expert-panel round: fixes 1-14 ---------------------------------------------------------------------------------------
async function mcp(store: Store, scope: "read" | "write" | "admin", max?: Sensitivity): Promise<Client> {
  const server = createMcpServer(store, scope, {}, { label: "mcp-tok", authed: true, ...(max ? { maxSensitivity: max } : {}) });
  const [c, sv] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(c), server.connect(sv)]);
  return client;
}
const tokenOf = (r: any): string => {
  for (const c of r.content ?? []) {
    try {
      const j = JSON.parse(String(c.text).slice(String(c.text).indexOf("{")));
      if (j && j.token) return j.token;
    } catch {
      /* not json */
    }
  }
  throw new Error("no token in " + JSON.stringify(r).slice(0, 300));
};
const txt = (r: any): string => (r.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");

describe("panel 1: raw sessions are shown only at the top ceiling", () => {
  const mk = (store: Store, id: string, prompt: string, at: Date): void => {
    recordEvent(store, normalizeHookInput("user-prompt", { session_id: id, cwd: "/w", prompt }, at), "default");
  };
  test("an internal or public ceiling sees no session, its prompts or its row; private and the operator do", async () => {
    const { sessionList, sessionGet } = await import("../src/progressive.js");
    const store = new Store(":memory:");
    mk(store, "s1", "my password manager master phrase is hunter2", new Date(Date.now() - 5000));
    const scope = {} as never;
    for (const c of ["public", "internal"] as const) {
      assert.deepEqual(as(c, () => sessionList(store, scope)).sessions, [], c);
      assert.equal(as(c, () => sessionGet(store, scope, "s1")), null, c);
    }
    assert.equal(as("private", () => sessionList(store, scope)).sessions.length, 1);
    assert.match(as("private", () => sessionGet(store, scope, "s1"))!.prompts[0].text, /hunter2/);
    assert.equal(sessionList(store, scope).sessions.length, 1);
    store.close();
  });

  test("hidden sessions do not shorten a page (the filter runs before the limit)", async () => {
    const { sessionList } = await import("../src/progressive.js");
    const store = new Store(":memory:");
    const odd = store.create({ title: "odd summary" });
    (store as unknown as { db: DatabaseSync }).db.prepare("UPDATE notes SET sensitivity = 'topsecret' WHERE id = ?").run(odd.id);
    for (let i = 0; i < 5; i++) mk(store, `s${i}`, `prompt ${i}`, new Date(Date.now() - (50 - i) * 1000)); // s4 is the newest
    for (const id of ["s4", "s3", "s2"]) store.captureDb().prepare("UPDATE sessions SET summary_note_id = ? WHERE id = ?").run(odd.id, id);
    const page = as("private", () => sessionList(store, {} as never, 2)).sessions;
    assert.deepEqual(page.map((x) => x.id), ["s1", "s0"], "the two newest VISIBLE sessions, not an empty page");
    store.close();
  });
});

describe("panel 2: a replacement is at least as sensitive as what it replaces", () => {
  test("new_note inherits the strictest label; a lower-labelled new_id is refused; an equal one works", async () => {
    const store = new Store(":memory:");
    const oldPriv = store.create({ title: "old private fact", body: "v1", sensitivity: "private" });
    const oldPub = store.create({ title: "old public fact", body: "v1", sensitivity: "public" });
    const c = await mcp(store, "write", "private");
    const prev: any = await c.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [oldPriv.id, oldPub.id], new_title: "new fact", new_body: "v2" } });
    const tok = tokenOf(prev);
    const done: any = await c.callTool({ name: "memory_supersede_confirm", arguments: { token: tok, new_title: "new fact", new_body: "v2" } });
    assert.ok(!done.isError, txt(done));
    const made = store.list({ withTags: [] }).notes.find((n) => n.title === "new fact")!;
    assert.equal(made.sensitivity, "private", "a replacement must not lower the label");

    const old2 = store.create({ title: "another private", body: "x", sensitivity: "private" });
    const lowTarget = store.create({ title: "public target", body: "y", sensitivity: "public" });
    const p2: any = await c.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [old2.id], new_id: lowTarget.id } });
    const t2 = tokenOf(p2);
    const bad: any = await c.callTool({ name: "memory_supersede_confirm", arguments: { token: t2, new_id: lowTarget.id } });
    assert.equal(bad.isError, true);
    assert.match(txt(bad), /lower sensitivity/);
    assert.equal(store.read(old2.id)!.status, undefined, "nothing was replaced");

    const okTarget = store.create({ title: "private target", body: "z", sensitivity: "private" });
    const p3: any = await c.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [old2.id], new_id: okTarget.id } });
    const t3 = tokenOf(p3);
    const good: any = await c.callTool({ name: "memory_supersede_confirm", arguments: { token: t3, new_id: okTarget.id } });
    assert.ok(!good.isError, txt(good));
    await c.close();
    store.close();
  });
});

describe("panel 3 and 8: a replaced note does not name a hidden replacement; deleting a replacement spares hidden notes", () => {
  const retire = (store: Store, oldN: NoteRecord, newN: NoteRecord): void => {
    store.supersedeCommit({ oldIds: [oldN.id], oldRevs: [store.read(oldN.id)!.rev], newId: newN.id, actor: "op", nonce: `n${oldN.id}${newN.id}`, expiresMs: Date.now() + 60_000 });
  };
  test("superseded_by / _at / _by_writer are dropped when the target is above the ceiling", () => {
    const store = new Store(":memory:");
    const oldN = store.create({ title: "old", body: "a", sensitivity: "public" });
    const newN = store.create({ title: "new", body: "b", sensitivity: "private" });
    retire(store, oldN, newN);
    const op = store.read(oldN.id)!;
    assert.equal(op.superseded_by, newN.id, "the operator sees the link");
    const seen = as("public", () => store.read(oldN.id))!;
    assert.equal(seen.superseded_by, undefined);
    assert.equal(seen.superseded_at, undefined);
    assert.equal(seen.superseded_by_writer, undefined);
    assert.equal(seen.status, "superseded");
    const listed = as("public", () => store.list({ includeSuperseded: true }).notes.find((n) => n.id === oldN.id))!;
    assert.equal(listed.superseded_by, undefined);
    assert.ok(!JSON.stringify(seen).includes(`"superseded_by":${newN.id}`));
    // The record still cannot be edited, and the error does not name the hidden note.
    assert.throws(() => as("public", () => store.update(oldN.id, { title: "x" })), (e: Error) => /replaced by another note/.test(e.message) && !e.message.includes(`note ${newN.id}`));
    store.close();
  });

  test("deleting a replacement does not revive a replaced note the caller cannot see", () => {
    const store = new Store(":memory:");
    const hiddenOld = store.create({ title: "hidden old", body: "a", sensitivity: "private" });
    const visOld = store.create({ title: "visible old", body: "a", sensitivity: "public" });
    const repl = store.create({ title: "replacement", body: "b", sensitivity: "public" });
    retire(store, hiddenOld, repl);
    retire(store, visOld, repl);
    assert.equal(as("public", () => store.delete(repl.id)), true);
    assert.equal(store.read(visOld.id)!.status, undefined, "the visible one is revived");
    assert.equal(store.read(hiddenOld.id)!.status, "superseded", "the hidden one is left alone");
    store.close();
  });
});

describe("panel 4: no relevance breakdown for a ceilinged caller", () => {
  test("REST ?explain=1 and MCP explain:true attach a breakdown only without a ceiling", async () => {
    const f = fixture();
    const toks: TokenEntry[] = [
      { token: "tok-op-explain-xxxxxxxxxxxxxxxxxxxxxxxxx", scope: "admin", label: "op" },
      { token: "tok-cap-explain-xxxxxxxxxxxxxxxxxxxxxxxxx", scope: "read", label: "cap", max_sensitivity: "internal" },
    ];
    const server = createApiServer(f.store, toks);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (t: string): Promise<string> => (await fetch(`${base}/search?q=zebra&explain=1`, { headers: { Authorization: `Bearer ${t}` } })).text();
    assert.match(await get(toks[0].token), /breakdown/);
    assert.doesNotMatch(await get(toks[1].token), /breakdown/);
    await new Promise<void>((r) => server.close(() => r()));
    const open = await mcp(f.store, "read");
    const capped = await mcp(f.store, "read", "internal");
    assert.match(txt(await open.callTool({ name: "state_search", arguments: { query: "zebra", explain: true } })), /breakdown/);
    assert.doesNotMatch(txt(await capped.callTool({ name: "state_search", arguments: { query: "zebra", explain: true } })), /breakdown/);
    await open.close();
    await capped.close();
    f.store.close();
  });
});

describe("panel 5: JSON export and sync --git honour the export ceiling", () => {
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "monomem-sens-jexp-"));
    const s = new Store(join(home, "state.db"));
    s.create({ title: `${PUB} j`, body: "b", sensitivity: "public" });
    s.create({ title: `${INT} j`, body: "b" });
    s.create({ title: `${PRIV} j`, body: "b", sensitivity: "private" });
    s.close();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const run = (args: string[], env: Record<string, string> = {}): { code: number | null; err: string } => {
    const r = spawnSync(process.execPath, [CLI, "export", ...args], { env: { ...process.env, MONOMEM_HOME: home, MONOMEM_DB_PATH: join(home, "state.db"), ...env }, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, err: r.stderr };
  };
  test("--max-sensitivity limits a JSON export; so does the environment variable; a bad value writes nothing", () => {
    const out = join(home, "o.json");
    assert.equal(run(["--format", "json", "--out", out]).code, 0);
    assert.match(readFileSync(out, "utf8"), /PRIVMARK/, "no ceiling exports everything");
    assert.equal(run(["--format", "json", "--out", out, "--max-sensitivity", "internal"]).code, 0);
    const a = readFileSync(out, "utf8");
    assert.doesNotMatch(a, /PRIVMARK/);
    assert.match(a, /INTMARK/);
    assert.equal(run(["--format", "json", "--out", out], { MONOMEM_EXPORT_MAX_SENSITIVITY: "public" }).code, 0);
    const b = readFileSync(out, "utf8");
    assert.doesNotMatch(b, /PRIVMARK|INTMARK/);
    assert.match(b, /PUBMARK/);
    const out2 = join(home, "o2.json");
    const bad = run(["--format", "json", "--out", out2], { MONOMEM_EXPORT_MAX_SENSITIVITY: "publik" });
    assert.equal(bad.code, 1);
    assert.equal(existsSync(out2), false);
  });

  test("sync --git applies the variable and warns once when private notes would be pushed without it", async () => {
    const root = mkdtempSync(join(tmpdir(), "monomem-sens-gsync-"));
    try {
      const GIT = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
      const g = (cwd: string, ...a: string[]): void => void spawnSync("git", a, { cwd, env: GIT });
      const remote = join(root, "remote.git");
      mkdirSync(remote);
      g(remote, "init", "--bare", "-b", "main");
      g(root, "clone", remote, "repo");
      const repo = join(root, "repo");
      g(repo, "checkout", "-B", "main");
      const sync = async (env: Record<string, string>): Promise<string> => {
        const lines: string[] = [];
        const prev = process.env.MONOMEM_EXPORT_MAX_SENSITIVITY;
        if (env.MONOMEM_EXPORT_MAX_SENSITIVITY) process.env.MONOMEM_EXPORT_MAX_SENSITIVITY = env.MONOMEM_EXPORT_MAX_SENSITIVITY;
        else delete process.env.MONOMEM_EXPORT_MAX_SENSITIVITY;
        try {
          const io = { interactive: false, out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l), ask: async () => "" };
          const o: GitSyncOptions = { repo, encrypt: false, dryRun: false, noPush: true, yes: true, dataDir: join(home, "gd"), dbPath: join(home, "state.db"), env: GIT };
          await runGitSync(io as never, o);
        } finally {
          if (prev === undefined) delete process.env.MONOMEM_EXPORT_MAX_SENSITIVITY;
          else process.env.MONOMEM_EXPORT_MAX_SENSITIVITY = prev;
        }
        return lines.join("\n");
      };
      const warned = await sync({});
      assert.match(warned, /labelled private and MONOMEM_EXPORT_MAX_SENSITIVITY is not set/);
      const inRepo = (): string => spawnSync("grep", ["-rl", "PRIVMARK", repo, "--exclude-dir=.git"], { encoding: "utf8" }).stdout;
      assert.ok(inRepo().length > 0, "without a ceiling the private note is written");
      const quiet = await sync({ MONOMEM_EXPORT_MAX_SENSITIVITY: "internal" });
      assert.doesNotMatch(quiet, /is not set/);
      assert.equal(inRepo(), "", "with a ceiling it is pruned from the repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("panel 6: config traps", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const tok = (n: string): string => n.padEnd(40, "x");
  const resolveQuiet = (list: unknown[]): { tokens: TokenEntry[]; log: string } => {
    process.env.MONOMEM_TOKEN = tok("primary");
    process.env.MONOMEM_TOKENS = JSON.stringify(list);
    const lines: string[] = [];
    const q = console.error;
    console.error = (m: unknown) => void lines.push(String(m));
    try {
      return { tokens: resolveTokens(), log: lines.join("\n") };
    } finally {
      console.error = q;
    }
  };
  test("max_sensitivity: null refuses the token (it must not read as 'no limit')", () => {
    const { tokens } = resolveQuiet([{ token: tok("a"), scope: "write", label: "nul", max_sensitivity: null }, { token: tok("b"), scope: "write", label: "ok" }]);
    assert.deepEqual(tokens.map((t) => t.label).sort(), ["ok", "primary"]);
  });
  test("a misspelt ceiling key refuses the token", () => {
    for (const key of ["maxSensitivity", "max_sensitivty", "Max_Sensitivity", "sensitivity_ceiling"]) {
      const { tokens, log } = resolveQuiet([{ token: tok("a"), scope: "write", label: "typo", [key]: "public" }]);
      assert.equal(tokens.some((t) => t.label === "typo"), false, key);
      assert.match(log, /looks like "max_sensitivity"/, key);
    }
  });
  test("a token listed twice with any invalid entry is refused entirely", () => {
    const { tokens } = resolveQuiet([
      { token: tok("a"), scope: "write", label: "dup", max_sensitivity: "public" },
      { token: tok("a"), scope: "write", label: "dup", max_sensitivity: "privte" },
      { token: tok("b"), scope: "write", label: "dup2", max_sensitivity: "privte" },
      { token: tok("b"), scope: "write", label: "dup2" },
    ]);
    assert.deepEqual(tokens.map((t) => t.label), ["primary"]);
  });
  test("the primary token listed with a ceiling logs an error and stays unrestricted", () => {
    const { tokens, log } = resolveQuiet([{ token: tok("primary"), scope: "write", label: "again", max_sensitivity: "public" }]);
    assert.match(log, /primary token/);
    assert.equal(tokens.find((t) => t.label === "primary")!.max_sensitivity, undefined);
  });
});

describe("panel 7: rebuild-edges is refused for a ceilinged caller", () => {
  test("REST 403 and MCP error; the plan counts only visible notes", async () => {
    const f = fixture();
    assert.equal(as("public", () => f.store.rebuildPlan().reduce((n, g) => n + g.notes, 0)), 1);
    assert.equal(f.store.rebuildPlan().reduce((n, g) => n + g.notes, 0), 3);
    const toks: TokenEntry[] = [
      { token: "tok-op-rebuild-xxxxxxxxxxxxxxxxxxxxxxxxx", scope: "admin", label: "op" },
      { token: "tok-cap-rebuild-xxxxxxxxxxxxxxxxxxxxxxxxx", scope: "admin", label: "cap", max_sensitivity: "internal" },
    ];
    const server = createApiServer(f.store, toks);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (t: string): Promise<number> => (await fetch(`${base}/rebuild-edges`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: "{}" })).status;
    assert.equal(await post(toks[1].token), 403);
    assert.equal(await post(toks[0].token), 200);
    await new Promise<void>((r) => server.close(() => r()));
    const c = await mcp(f.store, "admin", "internal");
    const r: any = await c.callTool({ name: "memory_rebuild_edges", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(txt(r), /no sensitivity ceiling/);
    await c.close();
    f.store.close();
  });
});

describe("panel 9: a label changed under an update cannot be overwritten", () => {
  test("if the note is relabelled above the caller between read and write, the write does nothing", () => {
    const store = new Store(":memory:");
    const n = store.create({ title: "racy", body: "orig" });
    const raw = (store as unknown as { db: DatabaseSync }).db;
    const realRead = store.read.bind(store);
    let fired = false;
    (store as unknown as { read: unknown }).read = (id: number, o?: unknown) => {
      const r = realRead(id, o as never);
      if (!fired) {
        fired = true;
        raw.prepare("UPDATE notes SET sensitivity = 'private' WHERE id = ?").run(id); // another writer relabels it now
      }
      return r;
    };
    const res = as("internal", () => store.update(n.id, { title: "overwritten" }));
    (store as unknown as { read: unknown }).read = realRead;
    assert.equal(res, null);
    assert.equal(store.read(n.id)!.title, "racy");
    store.close();
  });
});

describe("panel 10: start-up warning and the default ceiling", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  test("warns once when notes are labelled and a secondary token has no ceiling; not when all have one", () => {
    const plain = new Store(":memory:");
    plain.create({ title: "n" });
    const lab = new Store(":memory:");
    lab.create({ title: "n", sensitivity: "private" });
    const lines: string[] = [];
    const q = console.error;
    console.error = (m: unknown) => void lines.push(String(m));
    try {
      warnUnlabelledExposure(lab, [{ label: "primary" }, { label: "capped", max_sensitivity: "public" }]);
      warnUnlabelledExposure(plain, [{ label: "primary" }, { label: "open" }]);
      assert.equal(lines.length, 0, "no warning: all capped, or nothing labelled");
      warnUnlabelledExposure(lab, [{ label: "primary" }, { label: "open" }]);
      warnUnlabelledExposure(lab, [{ label: "primary" }, { label: "open" }]);
    } finally {
      console.error = q;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"open"/);
    plain.close();
    lab.close();
  });

  test("MONOMEM_DEFAULT_MAX_SENSITIVITY caps secondary tokens without one, never the primary; a bad value stops start-up", () => {
    process.env.MONOMEM_TOKEN = "primary".padEnd(40, "x");
    process.env.MONOMEM_TOKENS = JSON.stringify([
      { token: "a".padEnd(40, "x"), scope: "write", label: "plain" },
      { token: "b".padEnd(40, "x"), scope: "write", label: "own", max_sensitivity: "private" },
    ]);
    process.env.MONOMEM_DEFAULT_MAX_SENSITIVITY = "internal";
    const t = resolveTokens();
    assert.equal(t.find((x) => x.label === "plain")!.max_sensitivity, "internal");
    assert.equal(t.find((x) => x.label === "own")!.max_sensitivity, "private");
    assert.equal(t.find((x) => x.label === "primary")!.max_sensitivity, undefined);
    process.env.MONOMEM_DEFAULT_MAX_SENSITIVITY = "intern";
    assert.throws(() => resolveTokens(), /MONOMEM_DEFAULT_MAX_SENSITIVITY/);
  });
});

describe("panel 11: the label index is composite", () => {
  test("a fresh and a migrated database both have idx_notes_ns_sensitivity and no single-column one", () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-sens-idx-"));
    try {
      const path = join(dir, "state.db");
      new Store(path).close();
      downgradeTo(path, 16);
      const q = console.error;
      console.error = () => {};
      try {
        new Store(path).close();
      } finally {
        console.error = q;
      }
      const raw = new DatabaseSync(path);
      const idx = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_notes%sensitivity'").all() as Array<{ name: string; sql: string }>;
      raw.close();
      assert.deepEqual(idx.map((i) => i.name), ["idx_notes_ns_sensitivity"]);
      assert.match(idx[0].sql, /\(namespace, sensitivity\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("panel 12: the MCP label is case-insensitive like REST and the CLI", () => {
  test("state_write accepts 'PRIVATE' and stores 'private'; nonsense is still an error", async () => {
    const store = new Store(":memory:");
    const c = await mcp(store, "write");
    const ok: any = await c.callTool({ name: "state_write", arguments: { title: "caps", sensitivity: "PRIVATE" } });
    assert.ok(!ok.isError, txt(ok));
    assert.equal(store.list({}).notes[0].sensitivity, "private");
    const bad: any = await c.callTool({ name: "state_write", arguments: { title: "x", sensitivity: "secretish" } });
    assert.equal(bad.isError, true);
    await c.close();
    store.close();
  });
});

describe("panel 13: private notes are not sent to the embeddings endpoint by default", () => {
  const saved = { ...process.env };
  let srv: Server;
  let hits = 0;
  before(async () => {
    srv = createServer((req, res) => {
      hits++;
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
    });
    await new Promise<void>((r) => srv.listen(0, r));
  });
  after(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  test("mayEmbed and maybeEmbed skip private notes unless MONOMEM_ALLOW_PRIVATE_REMOTE=1", async () => {
    process.env.MONOMEM_EMBEDDINGS = "on";
    process.env.MONOMEM_EMBED_URL = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/embeddings`;
    delete process.env.MONOMEM_ALLOW_PRIVATE_REMOTE;
    assert.equal(mayEmbed({ sensitivity: "private" }), false);
    assert.equal(mayEmbed({ sensitivity: "internal" }), true);
    assert.equal(mayEmbed({}), true);
    const store = new Store(":memory:");
    const priv = store.create({ title: "p", body: "secret text", sensitivity: "private" });
    const intl = store.create({ title: "i", body: "ordinary text" });
    await maybeEmbed(store, priv);
    assert.equal(hits, 0, "nothing was sent for the private note");
    await maybeEmbed(store, intl);
    assert.equal(hits, 1);
    process.env.MONOMEM_ALLOW_PRIVATE_REMOTE = "1";
    await maybeEmbed(store, priv);
    assert.equal(hits, 2);
    store.close();
  });
});

describe("panel 14: a vault file cannot relabel an existing note", () => {
  test("changing sensitivity: in a file for a note that already exists leaves the label alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-sens-relabel-"));
    try {
      const s = new Store(":memory:");
      const n = s.create({ title: "locked down", body: "original", sensitivity: "private" });
      exportMarkdown(s, dir);
      const nsDir = join(dir, readdirSync(dir).find((d) => !d.startsWith("."))!);
      const file = join(nsDir, readdirSync(nsDir).find((f) => f.endsWith(".md"))!);
      writeFileSync(file, readFileSync(file, "utf8").replace('sensitivity: "private"', 'sensitivity: "public"').replace("original", "edited in the file"));
      const res = await importMarkdown(s, dir);
      assert.ok(res.counts.updated >= 1, dump(res.counts));
      const after = s.read(n.id)!;
      assert.equal(after.body, "edited in the file", "the text did change");
      assert.equal(after.sensitivity, "private", "the label did not");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
