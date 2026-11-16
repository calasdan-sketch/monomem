// The heavy part of a backup (VACUUM INTO, strip, VACUUM, integrity check) on a worker thread, so the server keeps serving
// while the daily backup copies the database: a 10k-note store (64 MB) took ~3 s on the main thread.
// The worker is an eval'd script that needs only node:sqlite, so it also runs from the one-file bundle (no worker file on disk).
import { Worker } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";

/**
 * Strip what never travels in a backup from the copy at `part`, compact it, prove it is consistent, and return its note count.
 * Self-contained (it uses only its parameters): it is also sent to the worker as source text.
 */
export function verifyCopy(Db: typeof DatabaseSync, part: string, keepApprovalKey: boolean): number {
  // The command-task approval key travels only when asked (--include-approval-key). What `monomem health` remembered about the
  // audit log (line count, last hash) never travels: restored next to another log it would read as tampering.
  const strip = new Db(part);
  try {
    strip.prepare(`DELETE FROM _meta WHERE key IN ('health_audit_seen'${keepApprovalKey ? "" : ", 'approval_key'"})`).run();
    strip.exec("VACUUM");
  } finally {
    strip.close();
  }
  const copy = new Db(part, { readOnly: true });
  try {
    const ic = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (ic.integrity_check !== "ok") throw new Error(`backup failed its integrity check: ${ic.integrity_check}`);
    return Number((copy.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
  } finally {
    copy.close();
  }
}

const WORKER_SOURCE = `
const { parentPort, workerData: w } = require("node:worker_threads");
process.removeAllListeners("warning"); // the one-line SQLite ExperimentalWarning, as quiet-sqlite.ts does on the main thread
const { DatabaseSync } = require("node:sqlite");
try {
  const src = new DatabaseSync(w.dbPath);
  try {
    src.exec("PRAGMA busy_timeout = " + Number(w.busyMs));
    src.prepare("VACUUM INTO ?").run(w.part);
  } finally {
    src.close();
  }
  parentPort.postMessage({ notes: (${verifyCopy.toString()})(DatabaseSync, w.part, w.keepApprovalKey) });
} catch (e) {
  parentPort.postMessage({ error: String((e && e.message) || e) });
}
`;

/** Copy the database at `dbPath` into `part` (a fresh file) on a worker thread from its own connection; resolves to the note count. */
export function copyInWorker(dbPath: string, part: string, keepApprovalKey: boolean, busyMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { dbPath, part, keepApprovalKey, busyMs } });
    let settled = false;
    w.once("message", (m: { notes?: number; error?: string }) => {
      settled = true;
      if (m.error !== undefined) reject(new Error(m.error));
      else resolve(Number(m.notes));
    });
    w.once("error", (e) => {
      if (!settled) reject(e);
      settled = true;
    });
    w.once("exit", (code) => {
      if (!settled) reject(new Error(`backup worker stopped (exit ${code})`));
      settled = true;
    });
  });
}
