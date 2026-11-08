import { Store } from "./store.js";
// A database that will not open: say which file, what likely happened, and what to do, in plain words.
export function describeDbFailure(path: string, err: unknown): { problem: string; fix: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/newer|schema/i.test(msg) && /v\d+|version/i.test(msg)) {
    return {
      problem: `database problem at ${path}: ${msg}`,
      fix: "This file was last used by a newer Monomem. Install the newest version (npm install -g monomem@latest), or restore an older copy of the file (monomem makes <file>.pre-v*-backup copies when it upgrades).",
    };
  }
  if (/malformed|corrupt|not a database|disk image|file is encrypted/i.test(msg)) {
    return {
      problem: `database problem at ${path}: the file looks damaged (${msg})`,
      fix: `Stop Monomem. If you have a backup (monomem backup makes them), copy it over ${path}. If not, move ${path} (and any state.db-wal / state.db-shm beside it) to a safe folder, then start Monomem again for a fresh empty one. Do not delete the damaged file until you are sure.`,
    };
  }
  if (/locked|busy/i.test(msg)) {
    return { problem: `database problem at ${path}: the file is locked (${msg})`, fix: "Another Monomem is probably running. Stop it, or wait a moment, then try again." };
  }
  if (/EACCES|EPERM|permission|readonly|read-only/i.test(msg)) {
    return { problem: `database problem at ${path}: no permission (${msg})`, fix: `Make sure your user can read and write ${path} and the folder it is in.` };
  }
  return { problem: `database problem at ${path}: ${msg}`, fix: "Run  monomem doctor  for more detail. If it keeps happening, restore a backup over the file (monomem backup makes them)." };
}

/** Open the database for a server; if it cannot be opened, say why and what to do, and stop (instead of a stack trace). */
export function openStoreOrExit(path: string): Store {
  try {
    return new Store(path);
  } catch (e) {
    const d = describeDbFailure(path, e);
    console.error(`[monomem] ${d.problem}`);
    console.error(`[monomem] Fix: ${d.fix}`);
    process.exit(1);
  }
}
