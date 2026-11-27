// r8: an import must leave the write lock free for long enough that another connection can take it (stress/saver-latency.mjs:
// with only a setImmediate gap another process's save waited 1-7 s). A probe connection that refuses to wait (busy_timeout 0)
// polls on a timer while the import runs: with real pauses between time-sliced batches it gets the lock many times.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { IMPORT_PAUSE_MS } from "../src/store/import-pacing.js";

test("a long import is cut into short lock holds with pauses another connection can use", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-yield-"));
  const s = new Store(join(dir, "state.db"), { bodyIndex: "off" });
  const probe = new DatabaseSync(join(dir, "state.db"));
  probe.exec("PRAGMA busy_timeout = 0;");
  let got = 0;
  const timer = setInterval(() => {
    try { probe.exec("BEGIN IMMEDIATE; COMMIT;"); got++; } catch { /* the import holds the lock right now */ }
  }, 5);
  try {
    const notes = Array.from({ length: 400 }, (_, i) => ({ title: `imp ${i}`, body: "text to import ".repeat(20) }));
    const t0 = Date.now();
    // lockMs 20: each batch holds the lock ~100 ms, however fast or slow this machine is
    await s.importNotes(notes as never, { deferEdges: true, lockMs: 100 } as never);
    const took = Date.now() - t0;
    assert.equal(s.countAll(), 400);
    const pauses = Math.floor(took / (IMPORT_PAUSE_MS + 100));
    assert.ok(got >= Math.min(5, pauses), `the probe took the lock ${got} times in ${took} ms; the import left no usable gap`);
  } finally {
    clearInterval(timer);
    probe.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
