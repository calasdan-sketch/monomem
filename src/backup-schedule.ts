// Automatic daily backups. The server's timer (start.ts) calls runDailyBackup about once an hour; it makes at most one backup
// a day into <data>/backups/<YYYY-MM-DD>/ with the same consistent hot copy `monomem backup` uses (backup.ts), then keeps the
// 7 newest days plus the newest backup of each of the 4 weeks before them. Nothing outside that folder is touched.
//
// The encryption key is never copied (a backup next to its key opens everything): the first backup of an encrypted store
// returns a one-time warning that the key needs its own copy. A failed backup is written to <data>/.backup-failed, which
// `monomem health` and the "Needs you" count read; the next good backup removes it.
// Turn it off with MONOMEM_AUTO_BACKUP=off (docs/configuration.md); disk use is in docs/footprint.md.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "./store.js";
import { backupStore } from "./backup.js";
import { keyPath } from "./crypto.js";

export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;
const DAY_MS = 86_400_000;
const NAME = /^\d{4}-\d{2}-\d{2}$/;
const FAILED = ".backup-failed";
const KEY_WARNED = ".backup-key-warned";

export const backupsDir = (dbPath: string): string => join(dirname(dbPath), "backups");

export const autoBackupOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(?:off|0|false|no)$/i.test((env.MONOMEM_AUTO_BACKUP ?? "").trim());

/** Which dated backups to keep: the KEEP_DAILY newest, then the newest one in each older week (Monday start), up to KEEP_WEEKLY weeks. */
export function keepSet(names: readonly string[]): Set<string> {
  const sorted = names.filter((n) => NAME.test(n)).sort().reverse();
  const keep = new Set(sorted.slice(0, KEEP_DAILY));
  const weeks = new Set<number>();
  for (const n of sorted.slice(KEEP_DAILY)) {
    if (weeks.size >= KEEP_WEEKLY) break;
    const week = Math.floor((Date.parse(n + "T00:00:00Z") / DAY_MS + 3) / 7); // day 0 (1970-01-01) was a Thursday
    if (weeks.has(week)) continue;
    weeks.add(week);
    keep.add(n);
  }
  return keep;
}

export interface DailyBackupResult {
  made: boolean;
  dir?: string;
  /** Set once, on the first backup of an encrypted store: the key is not in the backups and needs its own copy. */
  keyWarning?: string;
  /** Dated backup folders removed by rotation. */
  removed: string[];
  error?: string;
}

/** The last failed automatic backup, or null when the last attempt worked (or none was made). */
export function backupFailure(dbPath: string): { at: string; error: string } | null {
  try {
    const f = JSON.parse(readFileSync(join(dirname(dbPath), FAILED), "utf8")) as { at?: unknown; error?: unknown };
    return typeof f.at === "string" && typeof f.error === "string" ? { at: f.at, error: f.error } : null;
  } catch {
    return null;
  }
}

/** Make today's backup if there is none yet, then rotate. Never throws: a failure is recorded and returned. */
export function runDailyBackup(store: Store, dbPath: string, now = new Date()): DailyBackupResult {
  const root = backupsDir(dbPath);
  const day = now.toISOString().slice(0, 10); // ponytail: UTC day; a local-midnight boundary only shifts when the copy is made
  const dir = join(root, day);
  if (existsSync(join(dir, "state.db"))) return { made: false, removed: [] };
  const data = dirname(dbPath);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    backupStore(store, dbPath, dir);
  } catch (e) {
    const error = (e as Error).message;
    try {
      writeFileSync(join(data, FAILED), JSON.stringify({ at: now.toISOString(), error }) + "\n", { mode: 0o600 });
    } catch {
      /* the data folder itself is not writable: health reports that on its own */
    }
    return { made: false, removed: [], error };
  }
  try {
    unlinkSync(join(data, FAILED));
  } catch {
    /* there was no failure */
  }
  let keyWarning: string | undefined;
  const kp = keyPath(data);
  if (existsSync(kp) && !existsSync(join(data, KEY_WARNED))) {
    keyWarning =
      `Monomem now backs up your notes every day into ${root}. Your notes are encrypted and the key is NOT in those backups (on purpose): ` +
      `it is at ${kp}. Save a copy of that key somewhere else (a password manager or another drive); without it no backup can be read.`;
    try {
      writeFileSync(join(data, KEY_WARNED), now.toISOString() + "\n", { mode: 0o600 });
    } catch {
      /* said again next time: better than never */
    }
  }
  let removed: string[] = [];
  try {
    // Only folders dated today or earlier take part: after a clock change, today's copy is never removed and a folder dated
    // in the future is left alone instead of pushing real backups out.
    const names = readdirSync(root).filter((n) => NAME.test(n) && n <= day);
    const keep = keepSet(names).add(day);
    removed = names.filter((n) => !keep.has(n));
    for (const n of removed) rmSync(join(root, n), { recursive: true, force: true });
  } catch (e) {
    return { made: true, dir, removed, error: `backup made, but older ones could not be removed: ${(e as Error).message}`, ...(keyWarning ? { keyWarning } : {}) };
  }
  return { made: true, dir, removed, ...(keyWarning ? { keyWarning } : {}) };
}
