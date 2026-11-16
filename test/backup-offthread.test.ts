// The server's daily backup copies the database on a worker thread, so a request that arrives during the copy is answered
// at once instead of waiting for it (a 10k-note store paused serving ~3 s on the main thread). Baseline-relative: the
// request must come back in a fraction of the time the same copy takes on the main thread, no fixed milliseconds.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { runDailyBackup, runDailyBackupAsync, backupsDir } from "../src/backup-schedule.js";
import { createApiServer } from "../src/api.js";

test("daily backup off the main thread: a request during the copy is answered promptly; the copy is complete and verified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "om-bk-thread-"));
  const db = join(dir, "state.db");
  const store = new Store(db);
  const TOKEN = "tok-admin-1234567890abcdef";
  const server = createApiServer(store, [{ token: TOKEN, scope: "admin", label: "op" }]);
  try {
    store.create({ title: "a note", body: "kept safe" });
    // Bulk the file up quickly (the copy's cost is bytes, not notes).
    const raw = new DatabaseSync(db);
    raw.exec("CREATE TABLE IF NOT EXISTS bulk_filler(x BLOB); WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 40000) INSERT INTO bulk_filler SELECT randomblob(1024) FROM c;");
    raw.close();
    // Baseline: the same copy on the main thread.
    let t = performance.now();
    assert.equal(runDailyBackup(store, db, new Date("2026-11-10T09:00:00Z")).made, true);
    const onThread = performance.now() - t;

    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let backupDone = false;
    t = performance.now();
    const backup = runDailyBackupAsync(db, new Date("2026-11-11T09:00:00Z")).then((r) => ((backupDone = true), r));
    const res = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const answered = performance.now() - t;
    const stillCopying = !backupDone;
    assert.equal(res.status, 200);
    const r = await backup;
    assert.equal(r.made, true, r.error);
    assert.ok(existsSync(join(backupsDir(db), "2026-11-11", "state.db")));
    const copy = new DatabaseSync(join(backupsDir(db), "2026-11-11", "state.db"), { readOnly: true });
    assert.equal((copy.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c, 1);
    copy.close();
    assert.ok(stillCopying, "the request came back while the copy was still running");
    assert.ok(answered < onThread / 2, `request took ${answered.toFixed(0)} ms; the copy on the main thread took ${onThread.toFixed(0)} ms`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
