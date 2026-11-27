import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { planFixes, runFixes, undoLastFix, realCtx, type FixCtx } from "../src/doctor/fix.js";

function folder(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wow-fix-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const noIcacls = (): string => "";
const io = (out: string[], yes = true) => ({ yes, interactive: false, ask: async () => "n", out: (s: string) => void out.push(s) });

describe("doctor --fix", () => {
  test("nothing wrong: nothing planned, nothing created", async () => {
    const { dir, done } = folder();
    try {
      const out: string[] = [];
      const ctx = realCtx({ dataDir: dir, platform: "linux", icacls: noIcacls });
      assert.equal(planFixes(ctx).length, 0);
      assert.equal(await runFixes(ctx, io(out)), 0);
      assert.match(out.join("\n"), /Nothing to fix/);
      assert.equal(existsSync(join(dir, "doctor-fix")), false);
    } finally {
      done();
    }
  });

  test("a stale audit-log lock is moved away (not deleted) and undo moves it back; a fresh lock is left alone", async () => {
    const { dir, done } = folder();
    try {
      const log = join(dir, "audit.log");
      const lock = `${log}.append.lock`;
      mkdirSync(lock);
      const ctx = realCtx({ dataDir: dir, auditLog: log, platform: "linux", icacls: noIcacls });
      assert.equal(planFixes(ctx).length, 0, "a fresh lock is not stale");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const plan = planFixes(ctx);
      assert.deepEqual(plan.map((f) => f.id), ["stale-audit-lock"]);
      assert.match(plan[0].change, /Move it/);
      assert.equal(await runFixes(ctx, io([])), 1);
      assert.equal(existsSync(lock), false);
      assert.equal(readdirSync(join(dir, "doctor-fix")).filter((f) => f.endsWith("append.lock")).length, 1, "kept, not deleted");
      assert.equal(undoLastFix(ctx, () => undefined), 1);
      assert.equal(existsSync(lock), true);
    } finally {
      done();
    }
  });

  test("a server.pid whose program is gone is a stale record; a live one is not", async () => {
    const { dir, done } = folder();
    try {
      writeFileSync(join(dir, "server.pid"), JSON.stringify({ pid: 4242, port: 1 }));
      const dead = realCtx({ dataDir: dir, platform: "linux", icacls: noIcacls, alive: () => false });
      assert.deepEqual(planFixes(dead).map((f) => f.id), ["stale-server-pid"]);
      const live = realCtx({ dataDir: dir, platform: "linux", icacls: noIcacls, alive: () => true });
      assert.equal(planFixes(live).length, 0);
      assert.equal(await runFixes(dead, io([])), 1);
      assert.equal(existsSync(join(dir, "server.pid")), false);
    } finally {
      done();
    }
  });

  test("Windows folder open to Users: saves the permissions, locks the folder, and undo restores them (fake icacls)", async () => {
    const { dir, done } = folder();
    try {
      const calls: string[][] = [];
      const fake = (args: string[]): string => {
        calls.push(args);
        if (args[1] === "/save") writeFileSync(args[2], "saved");
        return args.length === 1 ? `${args[0]} BUILTIN\\Users:(OI)(CI)(R)\n  me:(F)\n` : "";
      };
      writeFileSync(join(dir, "state.db"), ""); // the Monomem marker the lockdown requires
      const ctx: FixCtx = realCtx({ dataDir: dir, platform: "win32", icacls: fake, env: { USERNAME: "me", USERDOMAIN: "PC" }, user: "me" });
      const plan = planFixes(ctx);
      assert.deepEqual(plan.map((f) => f.id), ["data-folder-acl"]);
      assert.match(plan[0].why, /BUILTIN\\Users/);
      assert.equal(await runFixes(ctx, io([])), 1);
      const save = calls.findIndex((c) => c[1] === "/save");
      const lock = calls.findIndex((c) => c.includes("/inheritance:r"));
      assert.ok(save > 0 && lock > save, "permissions saved before the change");
      undoLastFix(ctx, () => undefined);
      assert.equal(calls[calls.length - 1][1], "/restore");
    } finally {
      done();
    }
  });

  test("without --yes and not at a terminal the fix is listed but not applied", async () => {
    const { dir, done } = folder();
    try {
      writeFileSync(join(dir, "server.pid"), JSON.stringify({ pid: 4242, port: 1 }));
      const ctx = realCtx({ dataDir: dir, platform: "linux", icacls: noIcacls, alive: () => false });
      const out: string[] = [];
      assert.equal(await runFixes(ctx, io(out, false)), 0);
      assert.match(out.join("\n"), /Not applied/);
      assert.equal(existsSync(join(dir, "server.pid")), true);
    } finally {
      done();
    }
  });

  test("a search index that lost notes is rebuilt from the notes; notes are untouched", async () => {
    const { dir, done } = folder();
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "findable", body: "zebra stripes" });
      s.create({ title: "second", body: "giraffe neck" });
      s.close();
      const raw = new DatabaseSync(db);
      raw.exec("INSERT INTO notes_fts(notes_fts) VALUES('delete-all')");
      raw.close();
      const ctx = realCtx({ dataDir: dir, dbPath: db, platform: "linux", icacls: noIcacls });
      assert.deepEqual(planFixes(ctx).map((f) => f.id), ["search-index"]);
      assert.equal(await runFixes(ctx, io([])), 1);
      assert.equal(planFixes(ctx).length, 0, "fixed");
      const chk = new DatabaseSync(db);
      assert.equal(Number((chk.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c), 2);
      assert.equal(Number((chk.prepare("SELECT COUNT(*) c FROM notes_fts WHERE notes_fts MATCH 'zebra'").get() as { c: number }).c), 1);
      chk.close();
    } finally {
      done();
    }
  });

  test("the CLI refuses unknown options and prints the undo hint", () => {
    const { dir, done } = folder();
    try {
      mkdirSync(join(dir, "data"));
      const env = { ...process.env, MONOMEM_HOME: join(dir, "data"), ONEMEMORY_HOME: join(dir, "data") };
      const cli = join(import.meta.dirname, "..", "src", "cli.js");
      let status = 0;
      try {
        execFileSync(process.execPath, [cli, "doctor", "--fix", "--bogus"], { env, stdio: "pipe" });
      } catch (e) {
        status = (e as { status: number }).status;
      }
      assert.equal(status, 2);
    } finally {
      done();
    }
  });
});
