// A database created by THIS version has only ever been checked by this version's memory linter. Without this record,
// `monomem check --setup` told every brand-new user "your notes were last checked by an older memory linter" (a warn, on the
// first run). The record is lint-scan.json, the same file `check --rescan` writes; an existing one is never replaced.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PACKAGE_VERSION } from "../config.js";

/** Call before opening `dbPath`: true when the file does not exist yet (a new store). */
export const isNewStore = (dbPath: string): boolean => dbPath !== ":memory:" && !existsSync(dbPath);

/** Call after a new store opened: records the version that created it as its linter version. Never throws. */
export function markNewStoreScanned(dbPath: string): void {
  try {
    if (!existsSync(dbPath)) return; // a test double that opened nothing
    const dir = dirname(dbPath);
    const p = join(dir, "lint-scan.json");
    if (existsSync(p)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ scanned_version: PACKAGE_VERSION, scanned_at: new Date().toISOString() }) + "\n", { mode: 0o600, flag: "wx" });
  } catch {
    /* a read-only folder or a racing process: the worst case is the old once-only note */
  }
}
