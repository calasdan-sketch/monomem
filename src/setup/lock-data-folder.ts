// Windows: lock an EXISTING data folder to its owner and SYSTEM during setup (06-F6), so `monomem check` stops warning that
// Users / Authenticated Users can read the keys and notes. Best effort, never fatal; the old permissions are saved first
// (a note file) and `monomem setup --undo` turns inheritance back on (icacls /inheritance:e), which gives back the parent folder's permissions. Protects from other accounts on this PC only.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { lockdownArgs, wideAccessGroups } from "../private-dir.js";
import { lockdownRefusal } from "../doctor/folder-guard.js";

export const ACL_BACKUP_FILE = "setup-acl-backup.txt";
type Run = (args: string[]) => string;
const defaultRun: Run = (args) => execFileSync("icacls", args, { encoding: "utf8", timeout: 20_000, windowsHide: true });
interface Env { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; /** The account this process runs as (test hook). */ user?: string }

/** Tighten `dir` if icacls says other accounts can reach it. Returns a one-line message for the setup output, or "" when nothing was needed. */
export function lockDataFolder(e: Env, dir: string, run: Run = defaultRun): string {
  if (e.platform !== "win32" || e.env.MONOMEM_NO_CHMOD === "1" || !existsSync(dir)) return "";
  const refusal = lockdownRefusal(dir, { env: e.env, user: e.user });
  if (refusal) return `Did not change the permissions of ${dir}: ${refusal}.`;
  try {
    const before = run([dir]);
    if (wideAccessGroups(before).length === 0) return "";
    const args = lockdownArgs(dir, e.env);
    if (!args) return "";
    const backup = join(dirname(dir), `${basename(dir)}.${ACL_BACKUP_FILE}`);
    writeFileSync(backup, `Permissions of ${dir} before monomem setup locked it:
${before}`);
    run(args);
    return `Locked the data folder ${dir} to your account and SYSTEM (it was open to other accounts on this PC). monomem setup --undo puts the old access back (a note of the old permissions is in ${backup}).`;
  } catch (err) {
    return `Could not lock the data folder to your account (${(err as Error).message}). To do it by hand, run monomem check: it prints the icacls command.`;
  }
}

/** Turn inheritance back on; "" when setup saved none. */
export function restoreDataFolderLock(e: Env, dir: string, run: Run = defaultRun): string {
  const backup = join(dirname(dir), `${basename(dir)}.${ACL_BACKUP_FILE}`);
  if (e.platform !== "win32" || !existsSync(backup)) return "";
  try {
    run([dir, "/inheritance:e"]);
    rmSync(backup, { force: true });
    return `Gave the data folder ${dir} its inherited permissions back.`;
  } catch (err) {
    return `Could not restore the permissions on ${dir} (${(err as Error).message}); the note of the old ones is ${backup}.`;
  }
}
