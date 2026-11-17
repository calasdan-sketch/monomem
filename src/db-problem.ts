import { Store } from "./store.js";
import { missingKeyFile } from "./errors.js";
// A database that will not open: say which file, what likely happened, and what to do, in plain words.
export function describeDbFailure(path: string, err: unknown): { problem: string; fix: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const key = missingKeyFile(err);
  // A database backup is no help here: it is sealed with the same key. Only the key file brings the bodies back.
  if (key) return { problem: `the key file ${key} is missing, so the encrypted note bodies cannot be read`, fix: `Restore the key file ${key} from your backup (a database backup alone will not help: it is sealed with the same key).` };
  if (/newer|schema/i.test(msg) && /v\d+|version/i.test(msg)) {
    return {
      problem: `database problem at ${path}: ${msg}`,
      fix: "This file was last used by a newer Monomem. Install the newest version (npm install -g monomem@latest), or restore an older copy of the file (monomem makes <file>.pre-v*-backup copies when it upgrades).",
    };
  }
  if (/malformed|corrupt|not a database|disk image|file is encrypted/i.test(msg)) {
    return {
      problem: `database problem at ${path}: the file looks damaged (${msg})`,
      fix: `Stop Monomem. If you have a backup (monomem backup makes them), run: monomem restore <backup folder>  (it moves the damaged ${path} aside, with its -wal / -shm, and puts the backup in place). If not, move ${path} (and any state.db-wal / state.db-shm beside it) to a safe folder, then start Monomem again for a fresh empty one. Do not delete the damaged file until you are sure.`,
    };
  }
  if (/locked|busy/i.test(msg)) {
    return { problem: `database problem at ${path}: the file is locked (${msg})`, fix: "Another Monomem is probably running. Stop it, or wait a moment, then try again." };
  }
  if (/EACCES|EPERM|permission|readonly|read-only/i.test(msg)) {
    return { problem: `database problem at ${path}: no permission (${msg})`, fix: `Make sure your user can read and write ${path} and the folder it is in.` };
  }
  return { problem: `database problem at ${path}: ${msg}`, fix: "Run  monomem check --setup  for more detail. If it keeps happening, restore a backup over the file (monomem backup makes them)." };
}

/**
 * The HTTP server's lock wait. node:sqlite waits on the event loop, so while one request waits for another program's lock
 * every connected agent and /health wait too: keep it short and answer "busy, retry" (REST 503, MCP tool error). The CLI and
 * the stdio server keep the Store's 20 s (1.5.0, round 2 U-09).
 */
export const SERVER_BUSY_TIMEOUT_MS = 2000;

/** Open the database for a server; if it cannot be opened, say why and what to do, and stop (instead of a stack trace). */
export function openStoreOrExit(path: string, opts: { busyTimeoutMs?: number } = {}): Store {
  try {
    return new Store(path, opts);
  } catch (e) {
    const d = describeDbFailure(path, e);
    console.error(`[monomem] ${d.problem}`);
    console.error(`[monomem] Fix: ${d.fix}`);
    process.exit(1);
  }
}
