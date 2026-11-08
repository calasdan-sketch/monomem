// `monomem scrub`: remove the text of notes that were deleted long ago from the database file itself.
//
// Before 1.0.3 a deleted note's words could stay in the search index and in freed pages of the file. Scrubbing rebuilds
// the search index from the notes that exist, turns on "overwrite deleted data", and compacts the file (VACUUM), so
// those leftovers are gone. A backup is taken first. It works the same with and without encryption.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import { backupStore } from "./backup.js";

export interface ScrubResult {
  backupDir: string;
  beforeBytes: number;
  afterBytes: number;
  vacuumed: boolean;
}

/** The database file plus its write-ahead log: what actually sits on disk. */
export function diskBytes(dbPath: string): number {
  let n = 0;
  for (const f of [dbPath, `${dbPath}-wal`]) {
    try {
      if (existsSync(f)) n += statSync(f).size;
    } catch {
      /* gone meanwhile */
    }
  }
  return n;
}

export function runScrub(store: Store, dbPath: string, backupDir: string): ScrubResult {
  const beforeBytes = diskBytes(dbPath);
  const made = backupStore(store, dbPath, backupDir); // refuses to overwrite; the key is not copied
  // A very large file is still compacted: the person asked for it by name.
  const { vacuumed } = store.scrubPlaintext({ maxVacuumBytes: Number.MAX_SAFE_INTEGER });
  return { backupDir: made.dir, beforeBytes, afterBytes: diskBytes(dbPath), vacuumed };
}

export const mb = (n: number): string => (n / 1048576).toFixed(2) + " MB";
export const defaultScrubBackup = (home: string, now = new Date()): string =>
  join(home, `monomem-backup-before-scrub-${now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}`);
