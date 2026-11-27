import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCrashCheck, crashLine, writerEnv, cleanupCrashRun, guardCleanup } from "../src/cli/crashtest.js";
import { Store } from "../src/store.js";

describe("monomem check --crash", () => {
  test("kills writers on a copy and every acknowledged write is present", async () => {
    const r = await runCrashCheck({ writers: 2, rounds: 2 });
    assert.equal(r.kills, 4);
    assert.ok(r.acknowledged > 0, "no write was acknowledged");
    assert.equal(r.present, r.acknowledged);
    assert.deepEqual(r.lost, []);
    assert.equal(r.integrity, "ok");
    assert.match(crashLine(r), /4 kills.*\d+ acknowledged writes, \d+ present\. Integrity check: ok\. Result: ok\./);
  });

  test("the real store is only read: same notes, no new files beside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wow-crash-src-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "keep", body: "real note" });
      s.checkpointWal();
      s.close();
      const before = readdirSync(dir).sort();
      const realLog = join(dir, "audit.log");
      const saved = process.env.MONOMEM_AUDIT_LOG;
      process.env.MONOMEM_AUDIT_LOG = realLog; // stands in for the real audit log: the writers must never reach it
      let r;
      try {
        r = await runCrashCheck({ writers: 1, rounds: 1, source: db });
      } finally {
        if (saved === undefined) delete process.env.MONOMEM_AUDIT_LOG;
        else process.env.MONOMEM_AUDIT_LOG = saved;
      }
      assert.deepEqual(readdirSync(dir).filter((f) => !/^state.db-(shm|wal)$/.test(f)).sort(), before, "no new file (audit log, key, copy) beside the store");
      assert.equal(existsSync(realLog), false, "the real audit log was not written");
      assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith("monomem-crash-")), [], "the temp copy was removed");
      assert.equal(r.copiedFrom, "your store");
      const again = new Store(db);
      assert.equal(again.countAll(), 1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a lost acknowledged write is reported and fails the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wow-crash-fake-"));
    try {
      const fake = join(dir, "liar.mjs");
      writeFileSync(fake, 'import { writeSync } from "node:fs"; writeSync(1, "ACK 987654\\n"); setInterval(() => {}, 1000);');
      const r = await runCrashCheck({ writers: 1, rounds: 1, writerScript: fake });
      assert.deepEqual(r.lost, [987654]);
      assert.match(crashLine(r), /Result: FAIL\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("31-H1: the writers get their own home, database and audit log, never the real ones", async () => {
    const real = { MONOMEM_AUDIT_LOG: "/real/audit.log", MONOMEM_HOME: "/real", ONEMEMORY_HOME: "/real", MONOMEM_DB_PATH: "/real/state.db", MONOMEM_TOKEN: "t", PATH: "p" };
    const env = writerEnv("/tmp/x", real);
    for (const k of ["MONOMEM_AUDIT_LOG", "MONOMEM_HOME", "ONEMEMORY_HOME", "MONOMEM_DB_PATH"]) assert.ok(String(env[k]).startsWith(join("/tmp/x")) || String(env[k]).includes("x"), k);
    assert.equal(env.MONOMEM_AUDIT_LOG, join("/tmp/x", "audit.log"));
    assert.equal(env.MONOMEM_TOKEN, undefined);
    assert.equal(env.PATH, "p");
    // and the real spawn passes exactly that: a stand-in writer reports what it was given
    const dir = mkdtempSync(join(tmpdir(), "wow-crash-env-"));
    const report = join(dir, "env.txt");
    const spy = join(dir, "spy.mjs");
    writeFileSync(spy, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.CRASHTEST_REPORT, [process.env.MONOMEM_AUDIT_LOG, process.env.MONOMEM_HOME, process.env.MONOMEM_TOKEN ?? "none"].join("|")); process.stdout.write("ACK 1" + String.fromCharCode(10)); setInterval(() => {}, 1000);');
    const saved = { ...process.env };
    Object.assign(process.env, { CRASHTEST_REPORT: report, MONOMEM_AUDIT_LOG: "/real/audit.log", MONOMEM_TOKEN: "secret" });
    try {
      await runCrashCheck({ writers: 1, rounds: 1, writerScript: spy });
    } finally {
      for (const k of ["CRASHTEST_REPORT", "MONOMEM_AUDIT_LOG", "MONOMEM_TOKEN"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    const [audit, home, token] = readFileSync(report, "utf8").split("|");
    assert.match(audit, /monomem-crash-.*audit.log$/);
    assert.match(home, /monomem-crash-/);
    assert.equal(token, "none");
    rmSync(dir, { recursive: true, force: true });
  });

  test("31-H2: a writer whose reader has gone exits instead of looping forever", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wow-crash-pipe-"));
    try {
      const script = join(import.meta.dirname, "..", "src", "cli", "crash-writer.js");
      const env = writerEnv(dir);
      const c = spawn(process.execPath, [script, join(dir, "state.db"), "p"], { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
      await new Promise((r) => c.stdout.once("data", r)); // first ACK: it is writing
      c.stdout.destroy(); // the checker is gone
      const code = await Promise.race([new Promise<number | null>((r) => c.once("exit", (x) => r(x))), new Promise<string>((r) => setTimeout(() => r("still running"), 15000))]);
      if (code === "still running") c.kill("SIGKILL");
      assert.notEqual(code, "still running", "the writer must stop when the pipe closes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("31-H3: zero acknowledged writes fails the run, with the writer's last words", async () => {
    await assert.rejects(runCrashCheck({ writers: 1, rounds: 1, writerScript: join(tmpdir(), "no-such-writer.js"), ackWaitMs: 8000 }), /no writer saved a note.*(Cannot find module|writer said)/s);
    assert.match(crashLine({ writers: 1, rounds: 1, kills: 1, acknowledged: 0, present: 0, lost: [], integrity: "ok", copiedFrom: "an empty store" }), /Result: FAIL./);
  });

  test("30-F3: Ctrl+C or a kill removes the temp copy and stops the writers", () => {
    const dir = mkdtempSync(join(tmpdir(), "wow-crash-sig-"));
    writeFileSync(join(dir, "state.db"), "copy of your notes");
    const killed: string[] = [];
    const kid = { kill: (sig: string) => killed.push(sig) } as never;
    const codes: number[] = [];
    const unguard = guardCleanup(() => cleanupCrashRun(dir, [kid]), (c) => codes.push(c));
    process.emit("SIGINT");
    unguard();
    assert.equal(existsSync(dir), false, "temp copy removed on SIGINT");
    assert.deepEqual(killed, ["SIGKILL"]);
    assert.deepEqual(codes, [130]);
    cleanupCrashRun(dir, []); // twice is fine
  });

  test("bad options are refused", async () => {
    await assert.rejects(runCrashCheck({ writers: 0, rounds: 1 }), /--writers/);
    await assert.rejects(runCrashCheck({ writers: 1, rounds: 1000 }), /--rounds/);
  });
});
