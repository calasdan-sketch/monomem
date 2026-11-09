// `monomem restore <backup folder or state.db file>`: put a backup back as the live database.
// Order matters: check the backup first, check nothing is using the database, copy the current database aside, then swap.
import { copyFileSync, existsSync, renameSync, rmSync, statSync, unlinkSync, chmodSync } from "node:fs";
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

/** The message for a database another program has open. */
export const BUSY_MESSAGE =
  "Monomem looks like it is running (or an app is using the database). Close Claude Code, Claude Desktop and any other app that uses Monomem, stop the server, then run this again. Nothing was changed.";

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), by code or by wording. */
function isBusyError(e: unknown): boolean {
  const code = Number((e as { errcode?: unknown })?.errcode);
  return (Number.isFinite(code) && ((code & 0xff) === 5 || (code & 0xff) === 6)) || /locked|busy/i.test(String((e as Error)?.message ?? e));
}

/**
 * True when another process has the live database open, even idly (a server that is not writing still has it open).
 * Judged by the lock alone: an exclusive lock cannot be taken while any other connection holds the file. A damaged
 * file is NOT busy (it fails with another error), so restore can still replace it.
 */
export function dbBusy(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
  } catch (e) {
    return isBusyError(e);
  }
  try {
    db.exec("PRAGMA busy_timeout = 300");
    db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; SELECT count(*) FROM sqlite_master; ROLLBACK");
    return false;
  } catch (e) {
    return isBusyError(e);
  } finally {
    db.close();
  }
}

export interface RestoreResult {
  restored: RestorePlan;
  keptCurrentAt: string | null;
}

/** A file another program holds (Windows EPERM / EBUSY) becomes the plain "close the apps" message, never a stack. */
function friendly(e: unknown): unknown {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY" || isBusyError(e) ? new RestoreError(BUSY_MESSAGE) : e;
}

/**
 * Keep the current database beside itself, remove its -wal/-shm, put the backup in place and verify it.
 * A healthy current database is checkpointed and copied aside. One that cannot be checkpointed or is damaged is MOVED
 * aside as-is, with its -wal and -shm (renamed to match), so nothing in them is lost and restore still works.
 */
export function applyRestore(plan: RestorePlan, dbPath: string, now = new Date()): RestoreResult {
  if (dbBusy(dbPath)) throw new RestoreError(BUSY_MESSAGE);
  let keptCurrentAt: string | null = null;
  const tmp = join(dirname(dbPath), `.restore-${process.pid}.tmp`);
  try {
    if (existsSync(dbPath)) {
      const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
      keptCurrentAt = `${dbPath}.before-restore-${stamp}`;
      // Fold the write-ahead log into the file first, so a copy holds everything.
      let healthy = false;
      try {
        const cur = new DatabaseSync(dbPath);
        try {
          const ck = cur.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
          const qc = cur.prepare("PRAGMA quick_check(1)").get() as { quick_check?: string } | undefined;
          healthy = Number(ck?.busy ?? 0) === 0 && qc?.quick_check === "ok";
        } finally {
          cur.close();
        }
      } catch (e) {
        if (isBusyError(e)) throw new RestoreError(BUSY_MESSAGE);
        healthy = false; // damaged: moved aside below
      }
      if (healthy) {
        copyFileSync(dbPath, keptCurrentAt);
      } else {
        renameSync(dbPath, keptCurrentAt);
        for (const ext of ["-wal", "-shm"]) if (existsSync(dbPath + ext)) renameSync(dbPath + ext, keptCurrentAt + ext);
      }
      try {
        chmodSync(keptCurrentAt, 0o600);
      } catch {
        /* windows */
      }
    }
    copyFileSync(plan.source, tmp);
    for (const ext of ["-wal", "-shm", "-journal"]) {
      try {
        unlinkSync(dbPath + ext);
      } catch {
        /* not there */
      }
    }
    renameSync(tmp, dbPath);
  } catch (e) {
    throw friendly(e);
  } finally {
    rmSync(tmp, { force: true });
  }
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
