// Round 3, 01-F4 / 01-F3: a write that ends "busy" is retried with jitter; a first open after a hard kill retries a disk I/O error.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { beginImmediate, busyBudgetMs } from "../src/store/write-lock.js";
import { slow } from "./setup-env.js";
import { openDatabase, OPEN_IOERR_MESSAGE } from "../src/store/open-retry.js";

function twoConnections(busyMs: number): { a: DatabaseSync; b: DatabaseSync; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mm-retry-"));
  const open = (): DatabaseSync => {
    const d = new DatabaseSync(join(dir, "t.db"));
    d.exec(`PRAGMA busy_timeout = ${busyMs}; PRAGMA journal_mode = WAL;`);
    return d;
  };
  const a = open();
  const b = open();
  return { a, b, done: () => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("a short wait still fails at once (hooks must not stall)", () => {
  const { a, b, done } = twoConnections(250);
  a.exec("BEGIN IMMEDIATE");
  const t0 = Date.now();
  assert.throws(() => beginImmediate(b), /locked|busy/i);
  assert.ok(Date.now() - t0 < slow(1500));
  a.exec("ROLLBACK");
  done();
});

test("a lock nobody ever commits is refused after one wait, with no retry (stuck, not crowded)", () => {
  const { a, b, done } = twoConnections(1000);
  a.exec("BEGIN IMMEDIATE");
  const t0 = Date.now();
  assert.throws(() => beginImmediate(b, 20_000), /locked|busy/i);
  const took = Date.now() - t0;
  assert.ok(took < slow(3500), `gave up at once (took ${took} ms)`);
  a.exec("ROLLBACK");
  done();
});

/** A child that commits a few times fast, then holds the write lock for `holdMs`, then commits and ends. */
function crowdThenStall(file: string, holdMs: number) {
  return spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const d = new DatabaseSync(process.argv[1]); d.exec("PRAGMA busy_timeout=1000");
    for (let i = 0; i < 3; i++) { d.exec("BEGIN IMMEDIATE; INSERT INTO x VALUES (1)"); if (i === 0) console.log("held"); nap(100); d.exec("COMMIT"); }
    d.exec("BEGIN IMMEDIATE; INSERT INTO x VALUES (2)"); nap(${holdMs}); d.exec("COMMIT");`, file], { stdio: ["ignore", "pipe", "inherit"] });
}
function crowdDb(): { dir: string; file: string; b: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "mm-retry2-"));
  const file = join(dir, "t.db");
  const b = new DatabaseSync(file);
  b.exec("PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL; CREATE TABLE x(v)");
  return { dir, file, b };
}

test("31-M10: a write refused once is retried and succeeds, and the same crowd refuses it when retries are off", async () => {
  const { dir, file, b } = crowdDb();
  // The hold must end inside the second 1 s wait: a lock nobody commits through for a whole wait is refused by design (stuck, not crowded),
  // so a 2.5 s hold made this test fail on every machine (attempt 1 ends at ~1.4 s, attempt 2 hits the stuck rule at ~2.5 s).
  const holder = crowdThenStall(file, 1500);
  await new Promise((r) => holder.stdout.once("data", r));
  let retries = 0;
  beginImmediate(b, 6000, { onRetry: () => retries++ }); // attempt 1 ends busy (stall after progress); a retry lands once the holder commits
  assert.ok(retries >= 1, "a first refusal happened and was retried");
  assert.equal(b.isTransaction, true);
  b.exec("ROLLBACK");
  await new Promise((r) => holder.once("close", r));
  // Same crowd, retries off: the refusal reaches the caller.
  const again = crowdThenStall(file, 2500);
  await new Promise((r) => again.stdout.once("data", r));
  let none = 0;
  assert.throws(() => beginImmediate(b, 0, { onRetry: () => none++ }), /locked|busy/i);
  assert.equal(none, 0, "no retry with a zero budget");
  await new Promise((r) => again.once("close", r));
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("31-H4: the budget covers the waits themselves: a crowd that never stops is refused within the budget, not 3 waits later", async () => {
  const { dir, file, b } = crowdDb();
  const holder = spawn(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1]); d.exec("PRAGMA busy_timeout=1000");
    const end = Date.now() + 9000; let first = true;
    while (Date.now() < end) { d.exec("BEGIN IMMEDIATE; INSERT INTO x VALUES (1)"); if (first) { first = false; console.log("held"); } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60); d.exec("COMMIT"); }`, file], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => holder.stdout.once("data", r));
  const t0 = performance.now();
  assert.throws(() => beginImmediate(b, 1500), /locked|busy/i);
  const took = performance.now() - t0;
  holder.kill("SIGKILL");
  await new Promise((r) => holder.once("close", r));
  b.close();
  rmSync(dir, { recursive: true, force: true });
  assert.ok(took < slow(2800), `refused within the budget (took ${Math.round(took)} ms; before the fix: up to 3 busy timeouts)`);
});

test("MONOMEM_BUSY_RETRY_MS: default, valid, zero, and nonsense", () => {
  assert.equal(busyBudgetMs({}), 60_000);
  assert.equal(busyBudgetMs({ MONOMEM_BUSY_RETRY_MS: "25000" }), 25_000);
  assert.equal(busyBudgetMs({ MONOMEM_BUSY_RETRY_MS: "0" }), 0);
  assert.equal(busyBudgetMs({ MONOMEM_BUSY_RETRY_MS: "-5" }), 60_000);
  assert.equal(busyBudgetMs({ MONOMEM_BUSY_RETRY_MS: "soon" }), 60_000);
  assert.equal(busyBudgetMs({ MONOMEM_BUSY_RETRY_MS: "99999999" }), 600_000);
});

test("open retries a disk I/O error and then succeeds", () => {
  let tries = 0;
  const sleeps: number[] = [];
  const db = openDatabase("x.db", () => {
    if (++tries < 3) throw Object.assign(new Error("disk I/O error"), { errcode: 10 });
    return new DatabaseSync(":memory:");
  }, (ms) => sleeps.push(ms));
  assert.equal(tries, 3);
  assert.equal(sleeps.length, 2);
  db.close();
});

test("open retries a locked first open (the WAL switch on a new folder), then gives the error up", () => {
  let tries = 0;
  const locked = (): never => { tries++; throw Object.assign(new Error("database is locked"), { errcode: 5 }); };
  assert.throws(() => openDatabase("x.db", locked, () => {}), /database is locked/);
  assert.equal(tries, 8);
});

test("open gives a plain message when the disk I/O error never clears, and does not retry other errors", () => {
  assert.throws(() => openDatabase("x.db", () => { throw Object.assign(new Error("disk I/O error"), { errcode: 10 }); }, () => {}), (e: Error) => e.message === OPEN_IOERR_MESSAGE);
  let calls = 0;
  assert.throws(() => openDatabase("x.db", () => { calls++; throw new Error("file is not a database"); }, () => {}), /not a database/);
  assert.equal(calls, 1);
});

test("8 processes starting on one new empty folder all open it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-open8-"));
  const script = `const { Store } = await import(process.argv[1]); const s = new Store(process.argv[2] + "/state.db"); s.create({ title: "t" + process.pid, body: "b" }); s.close(); console.log("ok");`;
  const storeUrl = new URL("../src/store.js", import.meta.url).href;
  const runs = Array.from({ length: 8 }, () => new Promise<string>((done) => {
    let out = "";
    const c = spawn(process.execPath, ["--input-type=module", "-e", script, storeUrl, dir], { env: { ...process.env, MONOMEM_HOME: dir, ONEMEMORY_HOME: dir }, stdio: ["ignore", "pipe", "ignore"] });
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => done(out.trim()));
  }));
  assert.deepEqual(await Promise.all(runs), Array(8).fill("ok"));
  rmSync(dir, { recursive: true, force: true });
});
