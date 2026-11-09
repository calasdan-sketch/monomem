import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { backupStore } from "../src/backup.js";
import { inspectBackup, applyRestore, RestoreError, dbBusy } from "../src/restore.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

test("restore: a backup goes back as the live database, the current one is kept aside, wal/shm are removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-restore-"));
  try {
    const live = join(dir, "state.db");
    const s = new Store(live);
    s.create({ title: "before backup", body: "keep me" });
    backupStore(s, live, join(dir, "bk"));
    s.create({ title: "after backup", body: "not in the backup" });
    s.close();
    writeFileSync(live + "-wal", "stale");
    const plan = inspectBackup(join(dir, "bk"));
    assert.equal(plan.notes, 1);
    const r = applyRestore(plan, live, new Date("2026-11-08T10:00:00Z"));
    assert.ok(r.keptCurrentAt && existsSync(r.keptCurrentAt) && r.keptCurrentAt.endsWith("before-restore-20261108-100000"));
    assert.ok(!existsSync(live + "-wal"));
    const back = new Store(live);
    assert.equal(back.list({}).total, 1);
    back.close();
    const prev = new Store(r.keptCurrentAt!);
    assert.equal(prev.list({}).total, 2, "nothing was lost: the previous database is intact");
    prev.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses a missing folder, a non-database and a database newer than this build", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-restore-"));
  try {
    assert.throws(() => inspectBackup(join(dir, "nope")), RestoreError);
    mkdirSync(join(dir, "empty"));
    assert.throws(() => inspectBackup(join(dir, "empty")), /no state\.db/);
    writeFileSync(join(dir, "junk.db"), "this is not a database at all");
    assert.throws(() => inspectBackup(join(dir, "junk.db")), RestoreError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: restore <folder> without --yes changes nothing; with --yes it restores; restore <id> still un-archives a note", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-restore-"));
  try {
    const live = join(dir, "t.db");
    const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: live, MONOMEM_PORT: "58123" };
    const run = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { cwd: dir, env, encoding: "utf8" });
    run("add", "first note");
    assert.equal(run("backup", "--out", join(dir, "bk")).status, 0);
    run("add", "second note");
    const dry = run("restore", join(dir, "bk"));
    assert.equal(dry.status, 2, dry.stderr + dry.stdout);
    assert.match(dry.stdout, /Nothing was changed/);
    assert.match(run("ls").stdout, /second note/);
    const go = run("restore", join(dir, "bk"), "--yes");
    assert.equal(go.status, 0, go.stderr + go.stdout);
    assert.match(go.stdout, /Restored 1 note/);
    const after = run("ls").stdout;
    assert.ok(after.includes("first note") && !after.includes("second note"), after);
    run("forget", "1", "--yes");
    assert.equal(run("restore", "1").status, 0, "a number is still a note id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a database from a newer build: the stdio server prints one plain line (no stack trace) that names the pre-upgrade copy", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "om-restore-"));
  try {
    const live = join(dir, "state.db");
    new Store(live).close();
    const raw = new DatabaseSync(live);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    const r = spawnSync(process.execPath, [CLI, "mcp"], { cwd: dir, env: { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: live }, encoding: "utf8", input: "" });
    assert.equal(r.status, 1);
    const lines = r.stderr.split("\n").filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l));
    assert.equal(lines.length, 1, r.stderr);
    assert.match(lines[0], /newer than this build supports/);
    assert.match(lines[0], /state\.db\.pre-v99-backup/);
    assert.ok(!/\n\s+at /.test(r.stderr));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore replaces a damaged live database (moved aside as-is)", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-restore-bad-"));
  try {
    const live = join(dir, "state.db");
    const s = new Store(live);
    for (let i = 0; i < 30; i++) s.create({ title: `note ${i}`, body: "x".repeat(400) });
    backupStore(s, live, join(dir, "bk"));
    s.close();
    // XOR a run of bytes past the header: the file still opens as SQLite but its pages are garbage.
    const buf = readFileSync(live);
    for (let i = 4096; i < Math.min(buf.length, 4096 * 6); i++) buf[i] ^= 0x5a;
    writeFileSync(live, buf);
    const r = applyRestore(inspectBackup(join(dir, "bk")), live, new Date("2026-11-08T10:00:00Z"));
    assert.ok(r.keptCurrentAt && existsSync(r.keptCurrentAt), "the damaged file is kept");
    assert.deepEqual(readFileSync(r.keptCurrentAt!), buf, "moved aside as-is, byte for byte");
    const back = new Store(live);
    assert.equal(back.list({}).total, 30);
    back.close();
    assert.equal(readdirSync(dir).filter((f) => f.startsWith(".restore-")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses while another process holds an idle Store open, with the friendly message and no leftover tmp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "om-restore-busy-"));
  try {
    const live = join(dir, "state.db");
    const s = new Store(live);
    s.create({ title: "live", body: "x" });
    backupStore(s, live, join(dir, "bk"));
    s.close();
    const storeUrl = new URL("../src/store.js", import.meta.url).href;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `const { Store } = await import(${JSON.stringify(storeUrl)}); const s = new Store(${JSON.stringify(live)}); s.list({}); console.log("ready"); setInterval(() => {}, 1000);`], { env: { ...process.env, MONOMEM_HOME: dir }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise<void>((res, rej) => {
        holder.stdout!.on("data", (d) => String(d).includes("ready") && res());
        holder.on("exit", (c) => rej(new Error(`holder exited ${c}`)));
      });
      assert.equal(dbBusy(live), true, "an idle open connection counts as busy");
      assert.throws(() => applyRestore(inspectBackup(join(dir, "bk")), live), (e: Error) => e instanceof RestoreError && /Close Claude Code/.test(e.message) && !/at .*\.js/.test(e.message));
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: live, MONOMEM_PORT: "58124" };
      const cli = spawnSync(process.execPath, [CLI, "restore", join(dir, "bk"), "--yes"], { cwd: dir, env, encoding: "utf8" });
      assert.equal(cli.status, 1, cli.stdout + cli.stderr);
      assert.match(cli.stderr, /Close Claude Code/);
      assert.equal(readdirSync(dir).filter((f) => f.startsWith(".restore-")).length, 0, "no .restore-*.tmp left");
    } finally {
      holder.kill();
      await new Promise((r) => holder.once("exit", r));
    }
    assert.equal(dbBusy(live), false, "free again once the other process is gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
