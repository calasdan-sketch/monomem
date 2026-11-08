// `monomem restore <backup folder or state.db file>`: put a backup back as the live database.
// Order matters: check the backup first, check nothing is using the database, copy the current database aside, then swap.
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "./store.js";

export interface RestorePlan {
  source: string;
  schema: number;
  notes: number;
  encrypted: boolean;
}

export class RestoreError extends Error {}

/** Find the database file in what the person pointed at, and prove it opens, is whole and is not newer than this build. */
export function inspectBackup(input: string): RestorePlan {
  const p = resolve(input);
  if (!existsSync(p)) throw new RestoreError(`${p} does not exist.`);
  const source = statSync(p).isDirectory() ? join(p, "state.db") : p;
  if (!existsSync(source)) throw new RestoreError(`There is no state.db inside ${p}. Point at the backup folder (monomem backup made it) or at a state.db / state.db.pre-vNN-backup file.`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(source, { readOnly: true });
  } catch (e) {
    throw new RestoreError(`${source} is not a database Monomem can open (${(e as Error).message}).`);
  }
  try {
    let icv: string;
    try {
      icv = (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    } catch (e) {
      throw new RestoreError(`${source} is not a database Monomem can read (${(e as Error).message}).`);
    }
    const ic = { integrity_check: icv };
    if (ic.integrity_check !== "ok") throw new RestoreError(`${source} failed its integrity check (${ic.integrity_check}); it was not restored.`);
    const schema = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (schema > SCHEMA_VERSION) {
      throw new RestoreError(`${source} is schema v${schema}, newer than this build (v${SCHEMA_VERSION}). Upgrade first: npm i -g monomem@latest`);
    }
    let notes = 0;
    try {
      notes = Number((db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
    } catch {
      throw new RestoreError(`${source} has no notes table; it is not a Monomem database.`);
    }
    const encrypted = notes > 0 && Number((db.prepare("SELECT COUNT(*) AS c FROM notes WHERE body LIKE 'v1:%' OR body LIKE 'v2:%'").get() as { c: number }).c) > 0;
    return { source, schema, notes, encrypted };
  } finally {
    db.close();
  }
}

/** True when another process holds the write lock on the live database (a running server or app). */
export function dbBusy(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 300");
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

export interface RestoreResult {
  restored: RestorePlan;
  keptCurrentAt: string | null;
}

/** Back the current database up beside itself, remove its -wal/-shm, put the backup in place and verify it. */
export function applyRestore(plan: RestorePlan, dbPath: string, now = new Date()): RestoreResult {
  let keptCurrentAt: string | null = null;
  if (existsSync(dbPath)) {
    // Fold the write-ahead log into the file first, so the copy holds everything.
    const cur = new DatabaseSync(dbPath);
    try {
      cur.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      cur.close();
    }
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    keptCurrentAt = `${dbPath}.before-restore-${stamp}`;
    copyFileSync(dbPath, keptCurrentAt);
    try {
      chmodSync(keptCurrentAt, 0o600);
    } catch {
      /* windows */
    }
  }
  const tmp = join(dirname(dbPath), `.restore-${process.pid}.tmp`);
  copyFileSync(plan.source, tmp);
  for (const ext of ["-wal", "-shm", "-journal"]) {
    try {
      unlinkSync(dbPath + ext);
    } catch {
      /* not there */
    }
  }
  renameSync(tmp, dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    /* windows */
  }
  const check = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const ic = check.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (ic.integrity_check !== "ok") throw new RestoreError(`The restored database failed its integrity check (${ic.integrity_check}). Your previous database is at ${keptCurrentAt ?? "(there was none)"}.`);
  } finally {
    check.close();
  }
  return { restored: plan, keptCurrentAt };
}
