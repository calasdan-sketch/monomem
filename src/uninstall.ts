// `monomem uninstall [--purge] [--dry-run] [--yes] [--no-backup]`: take Monomem out of every app setup wired,
// and with --purge also delete the data folder (after a final backup).
//
// It reuses setup's own undo (setup.ts undoSession): every config file setup changed is put back from its backup when
// nothing touched it since (byte-identical; a file setup created is deleted), or else only the Monomem entry is taken
// out and the rest of the file is kept. Nothing setup did not record is changed: an entry you added by hand is listed,
// not removed. Like setup it shows the plan first and writes only after you type y.

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { dataHome, detectClients, hookHosts, readHistory, saveHistory, stamp, undoSession, type HistorySession, type SetupEnv, type SetupIO } from "./setup.js";

export interface UninstallOptions {
  dryRun: boolean;
  yes: boolean;
  purge: boolean;
  noBackup: boolean;
}

type Change = HistorySession["changes"][number];
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** How long `dirBytes` scans before giving up and reporting what it has so far (ms). */
export const DIR_BYTES_BUDGET_MS = 2000;

export interface DirSize {
  /** Bytes counted before the budget ran out (or the real total, when `truncated` is false). */
  bytes: number;
  /** True when the scan hit DIR_BYTES_BUDGET_MS before finishing — `bytes` is a lower bound, not the real size. */
  truncated: boolean;
}

/**
 * Total bytes of the files under `dir` ({ bytes: 0, truncated: false } when it is missing).
 * A synchronous recursive walk, same as before, but now time-boxed: a data folder that has
 * picked up unrelated junk (a user's own scripts dumping large backups next to it, say) used
 * to make `doctor`/`uninstall` hang for as long as the walk took, with no feedback at all —
 * this stops after DIR_BYTES_BUDGET_MS and says so, instead of blocking the whole CLI.
 */
export function dirBytes(dir: string, deadline: number = Date.now() + DIR_BYTES_BUDGET_MS): DirSize {
  let n = 0;
  if (Date.now() > deadline) return { bytes: n, truncated: true };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, truncated: false };
  }
  for (const d of entries) {
    if (Date.now() > deadline) return { bytes: n, truncated: true };
    const p = join(dir, d.name);
    try {
      if (d.isDirectory()) {
        const sub = dirBytes(p, deadline);
        n += sub.bytes;
        if (sub.truncated) return { bytes: n, truncated: true };
      } else if (d.isFile()) {
        n += statSync(p).size;
      }
    } catch {
      /* gone meanwhile */
    }
  }
  return { bytes: n, truncated: false };
}

/**
 * Top-level names Monomem itself writes in its data folder (the database and its side files, keys, tokens, the audit
 * log, the capture spool, setup's history, sync and runner state, backups). --purge deletes only these when the folder
 * also holds anything else, so a MONOMEM_HOME pointed at a busy folder never loses files that are not Monomem's.
 */
const OWN_ENTRY =
  /^(?:state\.db.*|demo\.db.*|\.token.*|\.key.*|\.attest-key.*|\.sync-key.*|\.last-backup|tokens\.json.*|spaces\.json.*|setup-history\.json.*|setup-hooks-declined|capture\.json.*|capture-spool\.jsonl.*|claude-import-held\.json.*|runner-allow\.json.*|runner-seen\.json.*|runner\.lock|login-code.*|audit\.log.*|spool|backups|sync-conflicts|\.sync-work-.*|README\.txt)$/;

/** Entries of `dir` that are not Monomem's (empty when it cannot be read). */
export function foreignEntries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !OWN_ENTRY.test(f));
  } catch {
    return [];
  }
}

/** Why a folder must never be purged (the home folder or a filesystem root), or "" when it may be. */
export function purgeRefusal(dir: string, home: string): string {
  const d = resolve(dir);
  const same = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(d, resolve(home)) || same(d, resolve(homedir()))) return `${d} is your home folder`;
  if (dirname(d) === d) return `${d} is the root of a drive`;
  return "";
}

/** What undo will do to one recorded change, in words (nothing is written). */
function describe(c: Change): string {
  if (!existsSync(c.real)) return "already gone, nothing to do";
  if (sha(readFileSync(c.real, "utf8")) === c.afterSha) return c.createdFile ? "delete it (setup created it)" : `put back the original (${c.backup})`;
  return "take out only the Monomem part (the file changed since setup; the rest is kept)";
}

/** App configs that still mention Monomem but were not changed by setup: listed, never touched. */
function leftovers(e: SetupEnv, recorded: Set<string>): string[] {
  const files = new Set([...detectClients(e).map((t) => t.file), ...hookHosts(e).map((h) => h.file)]);
  return [...files].filter((f) => {
    if (recorded.has(resolve(f))) return false;
    try {
      return /"monomem"\s*:|\[mcp_servers\.monomem\]|monomem[^\n]{0,160}\b(?:hook [a-z-]+|recall --budget-ms)/.test(readFileSync(f, "utf8"));
    } catch {
      return false;
    }
  });
}

/** Copy the whole data folder to `out`; the database through a consistent hot copy (backupStore), never a raw file copy. */
async function finalBackup(dir: string, out: string): Promise<void> {
  const db = join(dir, "state.db");
  if (existsSync(db)) {
    const { Store } = await import("./store.js");
    const { backupStore } = await import("./backup.js");
    const s = new Store(db);
    try {
      backupStore(s, db, out, { includeApprovalKey: true, includeAttestKey: true });
    } finally {
      s.close();
    }
  }
  // Everything else (tokens, spaces.json, spool, pre-upgrade copies...), without overwriting what backupStore wrote.
  cpSync(dir, out, { recursive: true, force: false, errorOnExist: false, filter: (src) => !/[\\/]state\.db(-wal|-shm|-journal)?$/.test(src) });
}

export async function runUninstall(e: SetupEnv, io: SetupIO, opts: UninstallOptions): Promise<number> {
  const all = readHistory(e);
  const sessions = all.filter((s) => !s.undone).reverse(); // newest first: each one's backup is the state the older one left
  const recorded = new Set(sessions.flatMap((s) => s.changes.map((c) => resolve(c.file))));
  const dir = dataHome(e);
  const backupDir = join(e.home, `monomem-final-backup-${stamp(e.now())}`);
  const configBackups = opts.purge ? sessions.flatMap((s) => s.changes.flatMap((c) => (c.backup ? [c.backup] : []))) : [];

  io.out("Monomem uninstall\n");
  io.out("What I will do:");
  let n = 1;
  for (const s of sessions) for (const c of [...s.changes].reverse()) io.out(`  ${n++}. ${c.label}: ${c.file}: ${describe(c)}`);
  if (!sessions.length) io.out("  (setup has not changed any app's configuration on this computer, or it was already undone)");
  const refusal = opts.purge ? purgeRefusal(dir, e.home) : "";
  if (refusal) {
    io.err(`Refusing --purge: the data folder ${refusal}. Deleting it would delete files that are not Monomem's. Set MONOMEM_HOME to Monomem's own folder, or remove its files by hand.`);
    return 1;
  }
  const others = opts.purge && existsSync(dir) ? foreignEntries(dir) : [];
  if (opts.purge) {
    if (existsSync(dir)) {
      if (!opts.noBackup) io.out(`  ${n++}. Make a final backup of ${dir} at ${backupDir}`);
      {
        const size = dirBytes(dir);
        const mb = `${(size.bytes / 1e6).toFixed(1)} MB${size.truncated ? "+, scan stopped early — folder is very large" : ""}`;
        if (others.length) {
          io.out(`  ${n++}. DELETE Monomem's files in ${dir}: every note, key and token${opts.noBackup ? ", with NO backup (--no-backup)" : ""}`);
          io.out(`     and leave the folder and the ${others.length} other file(s) in it: ${others.slice(0, 10).join(", ")}${others.length > 10 ? ", ..." : ""}`);
        } else io.out(`  ${n++}. DELETE the data folder ${dir} (${mb}): every note, key and token in it${opts.noBackup ? ", with NO backup (--no-backup)" : ""}`);
      }
    } else io.out(`  (no data folder at ${dir}; nothing to delete)`);
    for (const b of configBackups) io.out(`  ${n++}. Delete setup's copy ${b}`);
  } else io.out(`  Your notes in ${dir} are kept (add --purge to delete them too).`);
  const pinned = e.env.MONOMEM_DB_PATH?.trim();
  if (opts.purge && pinned && relative(dir, resolve(pinned)).startsWith("..")) io.out(`  (MONOMEM_DB_PATH points at ${pinned}, outside the data folder: it is NOT deleted)`);
  const left = leftovers(e, recorded);
  for (const f of left) io.out(`  (left alone) ${f} mentions Monomem, but setup did not add it; take it out by hand if you want`);
  io.out("");

  const nothing = sessions.length === 0 && !(opts.purge && (existsSync(dir) || configBackups.length));
  if (nothing) {
    io.out("Nothing to remove.");
    return 0;
  }
  if (opts.dryRun) {
    io.out("Dry run: nothing was changed.");
    return 0;
  }
  if (!opts.yes) {
    if (!io.interactive) {
      io.err("This is not an interactive terminal, so I cannot ask. Re-run with --yes to go ahead, or --dry-run to only look.");
      return 1;
    }
    const a = (await io.ask("Go ahead? Type y to continue, anything else cancels: ")).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      io.out("Cancelled. Nothing was changed.");
      return 0;
    }
  }

  io.out("Removed:");
  let failed = 0;
  for (const s of sessions) {
    const f = undoSession(e, io, s);
    failed += f;
    if (f === 0) s.undone = true;
  }
  if (sessions.length) saveHistory(e, all);
  if (failed) {
    io.err(`\n${failed} file(s) could not be put back (see above), so I stopped${opts.purge ? " and did NOT delete your data" : ""}. Fix that, then run uninstall again.`);
    return 1;
  }
  if (opts.purge) {
    if (existsSync(dir)) {
      if (!opts.noBackup) {
        try {
          await finalBackup(dir, backupDir);
        } catch (err) {
          io.err(`  The final backup failed (${(err as Error).message}), so your data was NOT deleted.`);
          return 1;
        }
        io.out(`  final backup made: ${backupDir}`);
      }
      // Re-read now: only Monomem's own entries go when anything else is in the folder.
      const foreign = foreignEntries(dir);
      try {
        if (!foreign.length) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
        else for (const f of readdirSync(dir)) if (OWN_ENTRY.test(f)) rmSync(join(dir, f), { recursive: true, force: true, maxRetries: 5 });
      } catch (err) {
        io.err(`  Could not delete ${dir} (${(err as Error).message}). Close every app using Monomem and run uninstall --purge again.`);
        return 1;
      }
      io.out(foreign.length ? `  deleted Monomem's files; left ${foreign.length} other file(s) in ${dir}` : `  deleted the data folder ${dir}`);
    }
    for (const b of configBackups) {
      try {
        unlinkSync(b);
        io.out(`  deleted ${b}`);
      } catch {
        /* already gone */
      }
    }
  }
  io.out("\nDone. Restart the apps that had Monomem so they forget it.");
  return 0;
}
