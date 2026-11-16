// Automatic daily backups (backup-schedule.ts): one a day into <data>/backups, 7 daily + 4 weekly kept, the key never
// copied (said once), a failure remembered for health / "Needs you", and a restore that can itself be undone.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { runDailyBackup, backupsDir, backupFailure, keepSet } from "../src/backup-schedule.js";
import { computeHealth } from "../src/digest.js";
import { runHealth } from "../src/health.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const DAY = 86_400_000;

function scratch(): { dir: string; db: string; store: Store; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "om-autobk-"));
  const db = join(dir, "state.db");
  const store = new Store(db);
  store.create({ title: "a note", body: "kept safe" });
  return { dir, db, store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("automatic daily backups", () => {
  test("one backup a day; a second run the same day does nothing", () => {
    const w = scratch();
    try {
      const now = new Date("2026-11-16T09:00:00Z");
      const a = runDailyBackup(w.store, w.db, now);
      assert.equal(a.made, true);
      assert.ok(existsSync(join(backupsDir(w.db), "2026-11-16", "state.db")));
      assert.equal(runDailyBackup(w.store, w.db, new Date(now.getTime() + 3_600_000)).made, false);
      assert.deepEqual(readdirSync(backupsDir(w.db)).filter((f) => !f.startsWith(".")), ["2026-11-16"]);
    } finally {
      w.done();
    }
  });

  test("40 days of daily runs leave exactly 7 daily + 4 weekly backups", () => {
    const w = scratch();
    try {
      const start = Date.parse("2026-10-01T09:00:00Z");
      for (let d = 0; d < 40; d++) runDailyBackup(w.store, w.db, new Date(start + d * DAY));
      const kept = readdirSync(backupsDir(w.db)).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)).sort();
      assert.equal(kept.length, 11, kept.join(" "));
      assert.deepEqual(kept.slice(-7), ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
    } finally {
      w.done();
    }
  });

  test("keepSet: 7 newest days, then the newest of each older week, at most 4 weeks", () => {
    const names = Array.from({ length: 30 }, (_, i) => new Date(Date.parse("2026-01-01T00:00:00Z") + i * DAY).toISOString().slice(0, 10));
    const keep = keepSet(names);
    assert.equal(keep.size, 11);
    for (const n of names.slice(-7)) assert.ok(keep.has(n), n);
  });

  test("the encryption key is never copied; the warning comes once", () => {
    const w = scratch();
    try {
      writeFileSync(join(w.dir, ".key"), "k".repeat(64));
      const a = runDailyBackup(w.store, w.db, new Date("2026-11-16T09:00:00Z"));
      assert.ok(a.keyWarning && /separately|somewhere else/.test(a.keyWarning), String(a.keyWarning));
      assert.ok(!existsSync(join(backupsDir(w.db), "2026-11-16", ".key")));
      const b = runDailyBackup(w.store, w.db, new Date("2026-11-17T09:00:00Z"));
      assert.equal(b.made, true);
      assert.equal(b.keyWarning, undefined, "said once");
    } finally {
      w.done();
    }
  });

  test("a failed backup is remembered (health and Needs you read it) and cleared by the next good one", async () => {
    const w = scratch();
    try {
      mkdirSync(backupsDir(w.db), { recursive: true });
      writeFileSync(join(backupsDir(w.db), "2026-11-16"), "a file where the folder should go");
      const a = runDailyBackup(w.store, w.db, new Date("2026-11-16T09:00:00Z"));
      assert.equal(a.made, false);
      assert.ok(a.error);
      const f = backupFailure(w.db);
      assert.ok(f && f.error.length > 0);
      const h = await runHealth({ dbPath: w.db, dataDir: w.dir, bindHost: "127.0.0.1", settingsPath: join(w.dir, ".claude", "settings.json"), pluginsPath: join(w.dir, "none.json"), auditPath: join(w.dir, "audit.log"), drill: async () => ({ ok: true, attacks: 1, reached: [], unexpected: [] }) as never });
      const line = h.checks.find((c) => c.id === "backup");
      assert.equal(line?.status, "warn", JSON.stringify(line));
      assert.match(line!.text, /automatic daily backup failed/);
      assert.equal(runDailyBackup(w.store, w.db, new Date("2026-11-17T09:00:00Z")).made, true);
      assert.equal(backupFailure(w.db), null);
    } finally {
      w.done();
    }
  });

  test("tidiness score: a missing backup no longer costs points (backups are automatic now)", () => {
    const counts = { duplicate: 0, stale_twin: 0, quarantined: 0, lint: 0, pii: 0, empty: 0, restated: 0 } as never;
    assert.equal(computeHealth({ counts, tokensWithoutCeiling: 0, backupAgeDays: null, noteCount: 5 }).score, 100);
  });
});

describe("backup restore <folder>", () => {
  test("backup restore takes a backup of the current state first, so the restore can be undone; old form still works with a notice", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-bkrestore-"));
    try {
      const live = join(dir, "t.db");
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: live, MONOMEM_PORT: "58124" };
      const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, env, encoding: "utf8" });
      run("add", "first note");
      assert.equal(run("backup", "--out", join(dir, "2026")).status, 0, "a folder named with digits only");
      run("add", "second note");
      const go = run("backup", "restore", join(dir, "2026"), "--yes");
      assert.equal(go.status, 0, go.stderr + go.stdout);
      assert.match(go.stdout, /Restored 1 note/);
      const undo = /To undo this restore: monomem backup restore "([^"]+)" --yes/.exec(go.stdout);
      assert.ok(undo, go.stdout);
      assert.ok(!run("ls").stdout.includes("second note"));
      const back = run("backup", "restore", undo[1], "--yes");
      assert.equal(back.status, 0, back.stderr + back.stdout);
      assert.match(run("ls").stdout, /second note/, "undoing the restore gives back what was there");

      // `restore <digits>` is always a note id now; the old `restore <folder>` form still works and says where it moved.
      const old = run("restore", join(dir, "2026"), "--yes");
      assert.equal(old.status, 0, old.stderr + old.stdout);
      assert.match(old.stderr, /monomem backup restore/);
      const r = spawnSync(process.execPath, [CLI, "restore", "2026"], { cwd: dir, env, encoding: "utf8" });
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stdout, /Restored/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
