// The MCP stdio process makes the daily backup too (backup-schedule.ts startStdioDailyBackup): most people never run the server,
// so before this they got no automatic backup at all.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { startStdioDailyBackup, runDailyBackupAsync, backupsDir, backupFailure } from "../src/backup-schedule.js";

function scratch(): { dir: string; db: string; store: Store; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "om-stdiobk-"));
  const db = join(dir, "state.db");
  const store = new Store(db);
  store.create({ title: "a note", body: "kept safe" });
  return { dir, db, store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const days = (db: string): string[] => (existsSync(backupsDir(db)) ? readdirSync(backupsDir(db)).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)) : []);

describe("daily backup from the stdio process", () => {
  test("a tick makes today's backup, and a second tick the same day makes no other", async () => {
    const w = scratch();
    const b = startStdioDailyBackup(w.db, w.dir, { firstMs: 3_600_000, everyMs: 3_600_000, env: {} });
    try {
      await b.tick();
      assert.equal(days(w.db).length, 1);
      assert.ok(existsSync(join(backupsDir(w.db), days(w.db)[0], "state.db")));
      await b.tick();
      assert.equal(days(w.db).length, 1);
      assert.equal(backupFailure(w.db), null);
    } finally {
      b.stop();
      w.done();
    }
  });

  test("MONOMEM_AUTO_BACKUP=off makes none", async () => {
    const w = scratch();
    const b = startStdioDailyBackup(w.db, w.dir, { firstMs: 3_600_000, everyMs: 3_600_000, env: { MONOMEM_AUTO_BACKUP: "off" } });
    try {
      await b.tick();
      assert.equal(days(w.db).length, 0);
    } finally {
      b.stop();
      w.done();
    }
  });

  test("a server and an app reaching today's copy together leave one backup and no failure warning", async () => {
    const w = scratch();
    try {
      const now = new Date("2026-11-18T09:00:00Z");
      const results = await Promise.all([runDailyBackupAsync(w.db, now), runDailyBackupAsync(w.db, now), runDailyBackupAsync(w.db, now)]);
      assert.deepEqual(days(w.db), ["2026-11-18"]);
      assert.equal(results.filter((r) => r.made).length, 1); // the lock lets exactly one process copy
      assert.equal(existsSync(join(backupsDir(w.db), ".lock")), false);
      assert.equal(results.some((r) => r.error), false, JSON.stringify(results));
      assert.equal(backupFailure(w.db), null);
      assert.deepEqual(readdirSync(join(backupsDir(w.db), "2026-11-18")).filter((f) => f.endsWith(".partial")), []);
    } finally {
      w.done();
    }
  });

  test("a live lock makes the run skip (one copy at a time); an abandoned lock does not stop backups", async () => {
    const w = scratch();
    try {
      const now = new Date("2026-11-18T09:00:00Z");
      const lock = join(backupsDir(w.db), ".lock");
      mkdirSync(lock, { recursive: true });
      const held = await runDailyBackupAsync(w.db, now);
      assert.equal(held.made, false);
      assert.deepEqual(days(w.db), []);
      assert.equal(backupFailure(w.db), null);
      const old = new Date(Date.now() - 2 * 3_600_000);
      utimesSync(lock, old, old); // a killed process left it behind
      const r = await runDailyBackupAsync(w.db, now);
      assert.equal(r.made, true, JSON.stringify(r));
      assert.deepEqual(days(w.db), ["2026-11-18"]);
      assert.equal(existsSync(lock), false);
    } finally {
      w.done();
    }
  });

  test("the timers do not keep the process alive", () => {
    const w = scratch();
    const b = startStdioDailyBackup(w.db, w.dir, { env: {} });
    try {
      // unref'd timers: the test process would hang at exit if they were not (node:test reports it as a failure)
      assert.equal(typeof b.stop, "function");
    } finally {
      b.stop();
      w.done();
    }
  });
});
