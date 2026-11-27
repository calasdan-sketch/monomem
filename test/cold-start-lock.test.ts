// r8: cold-start "database is locked". A real second process holds the file (rollback mode, read lock) while this one switches it
// to WAL, longer than one busy_timeout; the open must wait it out and succeed, not exit with "database is locked".
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store/open-retry.js";

test("an open that meets a lock held longer than one busy_timeout waits and then succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-cold-"));
  const db = join(dir, "state.db");
  const HOLD_MS = 2500; // > the 1000 ms busy_timeout openDatabase sets, so the first attempt must fail and be retried
  const script = `const { DatabaseSync } = await import("node:sqlite"); const d = new DatabaseSync(process.argv[1]);
    d.exec("PRAGMA journal_mode = DELETE; CREATE TABLE t(x); INSERT INTO t VALUES (1); BEGIN; SELECT * FROM t;");
    console.log("HELD"); setTimeout(() => { d.exec("COMMIT"); d.close(); }, ${HOLD_MS});`;
  const c = spawn(process.execPath, ["--input-type=module", "-e", script, db], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((ok) => c.stdout.on("data", (d: Buffer) => d.toString().includes("HELD") && ok()));
  const t0 = Date.now();
  const h = openDatabase(db); // synchronous: the holder's timer cannot be starved, it is another process
  const waited = Date.now() - t0;
  assert.equal((h.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.ok(waited >= 900, `expected the open to have waited out the lock, took ${waited} ms`);
  h.close();
  await new Promise((ok) => c.on("close", ok));
  rmSync(dir, { recursive: true, force: true });
});
