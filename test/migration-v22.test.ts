// Schema v22 (1.5.0, round 2): the F-05 indexes, note_flags (R2-02) and note_client_keys (R2-04) in one step. A v21 store
// upgrades without hiding any note; deleting a note removes its flag and client-key rows.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { downgradeTo } from "./legacy-db.js";

const names = (db: DatabaseSync, type: string) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all(type) as Array<{ name: string }>).map((r) => r.name);

function quietOpen(path: string): Store {
  const quiet = console.error;
  console.error = () => undefined;
  try {
    return new Store(path);
  } finally {
    console.error = quiet;
  }
}

describe("schema v22", () => {
  test("a fresh store has the v22 tables and indexes, and not the redundant edge index", () => {
    assert.equal(SCHEMA_VERSION, 22);
    const s = new Store(":memory:");
    const db = s.captureDb() as unknown as DatabaseSync;
    assert.ok(names(db, "table").includes("note_flags"));
    assert.ok(names(db, "table").includes("note_client_keys"));
    assert.ok(names(db, "table").includes("writer_events"));
    assert.ok(names(db, "table").includes("code_anchors"));
    const idx = names(db, "index");
    assert.ok(idx.includes("idx_notes_live_kind"), "(archived_at, kind) index");
    for (const i of ["idx_notes_obs", "idx_notes_tag_task", "idx_notes_tag_convention", "idx_notes_kind_summary", "idx_notes_pinned", "idx_notes_facts"]) assert.ok(idx.includes(i), `round-4 index ${i}`);
    assert.ok(!idx.includes("idx_note_edges_note_id"), "prefix of the note_edges primary key: dropped");
    s.close();
  });

  test("deleting a note removes its note_flags and note_client_keys rows", () => {
    const s = new Store(":memory:");
    const n = s.create({ title: "t", body: "b" });
    const db = s.captureDb() as unknown as DatabaseSync;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO note_flags (note_id, note_rev, flagged_by, reason, at) VALUES (?, 1, 'stdio:x', 'r', ?)").run(n.id, now);
    db.prepare("INSERT INTO note_client_keys (writer, key_hash, note_id, at) VALUES ('stdio:x', 'h', ?, ?)").run(n.id, now);
    db.prepare("INSERT INTO code_anchors (note_id, path, blob, commit_sha, repo_root, at) VALUES (?, 'a.ts', 'b', 'c', '/r', ?)").run(n.id, now);
    s.delete(n.id);
    assert.equal((db.prepare("SELECT count(*) AS c FROM code_anchors").get() as { c: number }).c, 0);
    assert.equal((db.prepare("SELECT count(*) AS c FROM note_flags").get() as { c: number }).c, 0);
    assert.equal((db.prepare("SELECT count(*) AS c FROM note_client_keys").get() as { c: number }).c, 0);
    s.close();
  });

  test("v21 -> v22: every note still listed, one backup at v21, idempotent reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-v22-"));
    try {
      const path = join(dir, "state.db");
      const s0 = new Store(path);
      const a = s0.create({ namespace: "work", title: "alpha deploy", body: "one" });
      const b = s0.create({ namespace: "work", title: "beta deploy", body: "two" });
      s0.close();
      downgradeTo(path, 21);
      assert.equal(Store.peekSchemaVersion(path), 21);
      const s = quietOpen(path);
      try {
        assert.equal(Store.peekSchemaVersion(path), 22);
        assert.equal(Store.peekSchemaVersion(path + ".pre-v22-backup"), 21);
        assert.deepEqual(s.list({ namespace: "work", limit: 10 }).notes.map((n) => n.id).sort(), [a.id, b.id].sort());
        assert.ok(names(s.captureDb() as unknown as DatabaseSync, "table").includes("note_flags"));
        assert.ok(names(s.captureDb() as unknown as DatabaseSync, "table").includes("code_anchors"));
      } finally {
        s.close();
      }
      quietOpen(path).close();
      assert.equal(Store.peekSchemaVersion(path), 22);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
