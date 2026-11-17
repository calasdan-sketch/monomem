// Automatic daily backups. The server's timer (start.ts) calls runDailyBackup about once an hour; it makes at most one backup
// a day into <data>/backups/<YYYY-MM-DD>/ with the same consistent hot copy `monomem backup` uses (backup.ts), then keeps the
// 7 newest days plus the newest backup of each of the 4 weeks before them. Nothing outside that folder is touched.
//
// The encryption key is never copied (a backup next to its key opens everything): the first backup of an encrypted store
// returns a one-time warning that the key needs its own copy. Every attempt is recorded in <data>/backup-status.json
// (ui/settings.ts, the same file the dashboard's "Back up now" writes): `monomem health`, the "Needs you" count and Settings
// all read that one file, and the next good backup clears a failure.
// Turn it off in the dashboard's Settings, or with MONOMEM_AUTO_BACKUP=off, which wins when set (docs/configuration.md);
// disk use is in docs/footprint.md.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "./store.js";
import { backupStore, backupStoreOffThread } from "./backup.js";
import { keyPath } from "./crypto.js";
import { readBackupStatus, writeBackupStatus } from "./ui/settings.js";
import { uiSwitch } from "./prompt/switches.js";

export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;
const DAY_MS = 86_400_000;
const NAME = /^\d{4}-\d{2}-\d{2}$/;
const KEY_WARNED = ".backup-key-warned";

export const backupsDir = (dbPath: string): string => join(dirname(dbPath), "backups");

export const autoBackupOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(?:off|0|false|no)$/i.test((env.MONOMEM_AUTO_BACKUP ?? "").trim());

/** Daily backups on? MONOMEM_AUTO_BACKUP wins when set; unset, the dashboard's Settings switch (default on). */
export function dailyBackupsOn(env: NodeJS.ProcessEnv, dataDir: string): boolean {
  if ((env.MONOMEM_AUTO_BACKUP ?? "").trim()) return autoBackupOn(env);
  return uiSwitch(dataDir, "daily_backups") !== "off";
}

/** The server timer's call: null when daily backups are off (checked every time, so the Settings switch applies at once). */
export function maybeDailyBackup(store: Store, dbPath: string, o: { env?: NodeJS.ProcessEnv; dataDir: string; now?: Date }): DailyBackupResult | null {
  return dailyBackupsOn(o.env ?? process.env, o.dataDir) ? runDailyBackup(store, dbPath, o.now) : null;
}

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

/** Removes one dated backup folder (tests pass a failing one). */
type RemoveFn = (dir: string) => void;
const removeDir: RemoveFn = (dir) => rmSync(dir, { recursive: true, force: true });

/** The last backup (daily or "Back up now") when it failed, or null when it worked (or none was made). One file: backup-status.json. */
export function backupFailure(dbPath: string): { at: string; error: string } | null {
  const s = readBackupStatus(dirname(dbPath));
  return s && !s.ok ? { at: s.at, error: s.error ?? "unknown error" } : null;
}

/** Make today's backup if there is none yet, then rotate. Never throws: a failure is recorded and returned. Copies on this thread. */
export function runDailyBackup(store: Store, dbPath: string, now = new Date(), rm: RemoveFn = removeDir): DailyBackupResult {
  const d = dailyTarget(dbPath, now);
  if (!d) return { made: false, removed: [] };
  try {
    mkdirSync(d.root, { recursive: true, mode: 0o700 });
    backupStore(store, dbPath, d.dir);
  } catch (e) {
    return failed(dbPath, now, e);
  }
  return afterDailyBackup(dbPath, now, d, rm);
}

/** runDailyBackup with the copy on a worker thread (the server's timer): serving does not pause while it copies. */
export async function runDailyBackupAsync(dbPath: string, now = new Date()): Promise<DailyBackupResult> {
  const d = dailyTarget(dbPath, now);
  if (!d) return { made: false, removed: [] };
  try {
    mkdirSync(d.root, { recursive: true, mode: 0o700 });
    await backupStoreOffThread(dbPath, d.dir);
  } catch (e) {
    return failed(dbPath, now, e);
  }
  return afterDailyBackup(dbPath, now, d);
}

/** The server timer's call, off the main thread: null when daily backups are off. */
export async function maybeDailyBackupAsync(dbPath: string, o: { env?: NodeJS.ProcessEnv; dataDir: string; now?: Date }): Promise<DailyBackupResult | null> {
  return dailyBackupsOn(o.env ?? process.env, o.dataDir) ? runDailyBackupAsync(dbPath, o.now) : null;
}

/** Today's backup folder, or null when it already exists. */
function dailyTarget(dbPath: string, now: Date): { root: string; day: string; dir: string } | null {
  const root = backupsDir(dbPath);
  const day = now.toISOString().slice(0, 10); // ponytail: UTC day; a local-midnight boundary only shifts when the copy is made
  const dir = join(root, day);
  return existsSync(join(dir, "state.db")) ? null : { root, day, dir };
}

function failed(dbPath: string, now: Date, e: unknown): DailyBackupResult {
  const error = (e as Error).message;
  try {
    writeBackupStatus({ ok: false, at: now.toISOString(), error }, dirname(dbPath));
  } catch {
    /* the data folder itself is not writable: health reports that on its own */
  }
  return { made: false, removed: [], error };
}

/** Status, the one-time key warning and rotation, after a good copy. */
function afterDailyBackup(dbPath: string, now: Date, d: { root: string; day: string; dir: string }, rm: RemoveFn = removeDir): DailyBackupResult {
  const { root, day, dir } = d;
  const data = dirname(dbPath);
  try {
    writeBackupStatus({ ok: true, at: now.toISOString(), dir }, data);
  } catch {
    /* as above */
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
    for (const n of removed) rm(join(root, n));
  } catch (e) {
    // Recorded as a failure: old copies that stay fill the disk, and check / Needs you only read the status file.
    const error = `backup made, but older ones could not be removed: ${(e as Error).message}`;
    try {
      writeBackupStatus({ ok: false, at: now.toISOString(), dir, error }, data);
    } catch {
      /* as above */
    }
    return { made: true, dir, removed, error, ...(keyWarning ? { keyWarning } : {}) };
  }
  return { made: true, dir, removed, ...(keyWarning ? { keyWarning } : {}) };
}
