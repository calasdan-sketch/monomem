// 1.5.0 (round 2, S-04): a process that opened the database before a newer build upgraded it refuses to write.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SchemaNewerError, SCHEMA_VERSION, QuarantinedError } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";

test("S-04 after another program moves the file to a newer schema, writes are refused and nothing is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-s04-"));
  const path = join(dir, "state.db");
  const a = new Store(path);
  try {
    a.create({ title: "before" });
    const other = new DatabaseSync(path);
    other.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    other.close();
    assert.throws(() => a.create({ title: "after" }), (e: unknown) => e instanceof SchemaNewerError && /restart this app/i.test((e as Error).message));
    const n = (a.captureDb().prepare("SELECT COUNT(*) c FROM notes WHERE title = 'after'").get() as { c: number }).c;
    assert.equal(n, 0);
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-04 (final-architecture SF-3): the operator's keep-flagged, resume and reject are refused too, and change nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-s04c-"));
  const path = join(dir, "state.db");
  const a = new Store(path);
  try {
    setProcessWriter("stdio:a");
    const n = a.create({ title: "flag me" });
    setProcessWriter("stdio:b");
    a.flagNote(n.id, "looks wrong");
    setProcessWriter("cli");
    a.setApproveFirst("held", true);
    setProcessWriter("stdio:a");
    let qid = 0;
    try {
      a.create({ namespace: "held", title: "held write" });
    } catch (e) {
      if (!(e instanceof QuarantinedError)) throw e;
      qid = e.quarantineId;
    }
    setProcessWriter("cli");
    a.captureDb().prepare("INSERT INTO _meta (key, value) VALUES ('flood_paused', '[\"stdio:b\"]') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const other = new DatabaseSync(path);
    other.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    other.close();
    const newer = (e: unknown) => e instanceof SchemaNewerError;
    assert.throws(() => a.keepFlagged(n.id), newer, "keep-flagged");
    assert.throws(() => a.resumeWriter("stdio:b"), newer, "resume");
    assert.throws(() => a.rejectQuarantine(qid), newer, "reject");
    const db = a.captureDb();
    assert.equal((db.prepare("SELECT COUNT(*) c FROM note_flags WHERE cleared_at IS NULL").get() as { c: number }).c, 1);
    assert.deepEqual(a.pausedWriters(), ["stdio:b"]);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM quarantine").get() as { c: number }).c, 1);
  } finally {
    setProcessWriter("");
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-04 (final-security SF2): delete, archive, restore and pin are refused too", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-s04b-"));
  const path = join(dir, "state.db");
  const a = new Store(path);
  try {
    const n = a.create({ title: "keep" });
    const gone = a.create({ title: "archived" });
    a.archive(gone.id);
    const other = new DatabaseSync(path);
    other.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    other.close();
    const newer = (e: unknown) => e instanceof SchemaNewerError;
    assert.throws(() => a.delete(n.id), newer, "delete");
    assert.throws(() => a.archive(n.id), newer, "archive");
    assert.throws(() => a.restore(gone.id), newer, "restore");
    assert.throws(() => a.setPinned(n.id, false), newer, "unpin");
    const live = a.captureDb().prepare("SELECT archived_at FROM notes WHERE id = ?").get(n.id) as { archived_at: string | null } | undefined;
    assert.ok(live && live.archived_at === null, "the note is still there and live");
    const g = a.captureDb().prepare("SELECT archived_at FROM notes WHERE id = ?").get(gone.id) as { archived_at: string | null };
    assert.ok(g.archived_at !== null, "the archived note stays archived");
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
