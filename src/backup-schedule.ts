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
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  // One copy at a time across processes: the server and every app's MCP process run this check, and a second full copy
  // of a large store only wastes disk and IO. A lock folder (mkdir is atomic) held by a live copy makes the others skip;
  // it counts as abandoned after 30 minutes (a killed process), so a crash never stops backups for good.
  const lock = join(d.root, ".lock");
  try {
    mkdirSync(d.root, { recursive: true, mode: 0o700 });
    if (!takeLock(lock)) return { made: false, removed: [] };
  } catch (e) {
    return failed(dbPath, now, e);
  }
  try {
    await backupStoreOffThread(dbPath, d.dir);
  } catch (e) {
    // Backups never overwrite: if today's copy appeared meanwhile, that is not a failure and must not raise a warning.
    if ((e as { code?: string }).code === "EBACKUP_EXISTS" && existsSync(join(d.dir, "state.db"))) return { made: false, removed: [] };
    return failed(dbPath, now, e);
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* the next run treats an old lock as abandoned */
    }
  }
  return afterDailyBackup(dbPath, now, d);
}

const LOCK_STALE_MS = 30 * 60_000;
/** True when this process now holds the lock folder; false when a live copy holds it. */
function takeLock(lock: string): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
        rmSync(lock, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * The MCP stdio process's daily backup. Most people only ever run Monomem through their apps (stdio), never the server whose
 * timer makes the backup, so they got none. Same check as the server's: a first look about a minute after start (a random
 * extra delay, so several apps starting together do not all copy at once), then hourly; at most one copy a day; the
 * Settings switch and MONOMEM_AUTO_BACKUP=off apply. Quiet on success; a failure is one line on stderr and in backup-status.json.
 */
export function startStdioDailyBackup(dbPath: string, dataDir: string, o: { firstMs?: number; everyMs?: number; env?: NodeJS.ProcessEnv } = {}): { stop: () => void; tick: () => Promise<void> } {
  let running = false;
  let lastSaid = 0; // a folder that can never be written would otherwise log the same line every hour, forever
  const say = (m: string): void => {
    if (Date.now() - lastSaid < 86_400_000) return;
    lastSaid = Date.now();
    process.stderr.write(`[monomem] automatic backup failed: ${m.replace(/\s+/g, " ")} (monomem check shows it)\n`);
  };
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const r = await maybeDailyBackupAsync(dbPath, { dataDir, env: o.env });
      if (r?.error) say(r.error);
    } catch (e) {
      say(String((e as Error).message ?? e));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), o.firstMs ?? 60_000 + Math.floor(Math.random() * 30_000));
  const every = setInterval(() => void tick(), o.everyMs ?? 3_600_000);
  first.unref();
  every.unref();
  return { stop: () => (clearTimeout(first), clearInterval(every)), tick };
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
