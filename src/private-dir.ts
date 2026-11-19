// privateDir and its helpers, in a module with no import-time side effects so setup.ts can use it without loading
// config.ts (which resolves the data folder, and can throw on a bad MONOMEM_HOME, when it is first imported).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";

/** chmod that is a no-op on Windows and never throws (permissions are best-effort hardening). */
export function chmodQuiet(p: string, mode: number): void {
  // MONOMEM_NO_CHMOD=1 leaves permissions alone (deliberately shared dirs,
  // e.g. a Docker volume read by a backup sidecar running as another uid).
  if (process.platform === "win32" || process.env.MONOMEM_NO_CHMOD === "1") return;
  try {
    chmodSync(p, mode);
  } catch {
    /* missing file or not ours: leave it */
  }
}

/**
 * 1.5.0: the icacls arguments that leave a folder to its owner and SYSTEM (inheritance removed, so Users/Everyone lose it).
 * null when the user name is unknown: no guessing. Protects from other accounts on the PC, not from programs running as you.
 */
export function lockdownArgs(dir: string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  const user = env.USERNAME?.trim();
  if (!user) return null;
  const domain = env.USERDOMAIN?.trim();
  return [dir, "/inheritance:r", "/grant:r", `${domain ? domain + "\\" : ""}${user}:(OI)(CI)F`, "SYSTEM:(OI)(CI)F", "/remove:g", ...WIDE_SIDS];
}

/**
 * Administrators, Users, Authenticated Users, Everyone, by SID (same on every Windows language). Removed explicitly: a
 * folder created from an elevated (administrator) prompt gets its own non-inherited Administrators entry, which
 * `/inheritance:r` alone leaves in place (seen on GitHub's Windows runners).
 */
const WIDE_SIDS = ["*S-1-5-32-544", "*S-1-5-32-545", "*S-1-5-11", "*S-1-1-0"];

const WIDE_GROUPS = ["BUILTIN\\Administrators", "BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users", "Everyone"];
/** The groups that reach beyond the owner in the output of `icacls <dir>` (`monomem doctor` names them on Windows). */
export function wideAccessGroups(icaclsOutput: string): string[] {
  return WIDE_GROUPS.filter((g) => new RegExp(`(^|\\s)${g.replace(/\\/g, "\\\\")}:`, "im").test(icaclsOutput));
}

/** The icacls arguments that leave ONE file to the current user alone (inheritance removed). null when the user name is unknown. */
export function fileLockdownArgs(file: string, env: NodeJS.ProcessEnv = process.env): string[] | null {
  const user = env.USERNAME?.trim();
  if (!user) return null;
  const domain = env.USERDOMAIN?.trim();
  return [file, "/inheritance:r", "/grant:r", `${domain ? domain + "\\" : ""}${user}:F`];
}

export interface PrivateDirOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: (args: string[]) => void;
}
const runIcacls = (args: string[]): void => void execFileSync("icacls", args, { stdio: "ignore", timeout: 15_000, windowsHide: true });

let warnedFileAcl = false;
/**
 * 2026-11-18: the Windows counterpart of mode 0600 for a key or token file (the access token, the signing and encryption
 * keys, tokens.json): remove inherited permissions and grant only the current user, with icacls (no shell). Best effort: a
 * failure (icacls missing, unknown user name, a file system without ACLs) prints one warning per process and never stops
 * startup. It protects from other accounts on this PC, not from programs running as you. A no-op off Windows.
 */
export function restrictFile(file: string, o: PrivateDirOptions = {}): void {
  if ((o.platform ?? process.platform) !== "win32") return;
  const env = o.env ?? process.env;
  if (!o.run && env.MONOMEM_NO_CHMOD === "1") return; // deliberately shared files: leave the permissions alone
  try {
    const args = fileLockdownArgs(file, env);
    if (!args) throw new Error("the Windows user name is unknown");
    (o.run ?? runIcacls)(args);
  } catch (e) {
    if (warnedFileAcl) return;
    warnedFileAcl = true;
    console.error(`[monomem] could not restrict ${file} to your account with icacls (${(e as Error).message}); other accounts on this PC may be able to read it. Fix: icacls "${file}" /inheritance:r /grant:r "%USERDOMAIN%\\%USERNAME%:F"`);
  }
}

/**
 * Create `dir` owner-only (0700) and re-tighten it if it already existed looser. On Windows a folder created here is also
 * locked to its owner and SYSTEM with icacls (no shell, best effort: a failure is one warning, never fatal). An existing
 * folder is not touched here (no icacls call on the hot path); `monomem doctor` checks it.
 */
export function privateDir(dir: string, o: PrivateDirOptions = {}): void {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(dir, 0o700);
  if (existed || (o.platform ?? process.platform) !== "win32") return;
  try {
    const args = lockdownArgs(dir, o.env ?? process.env);
    if (!args) throw new Error("the Windows user name is unknown");
    (o.run ?? runIcacls)(args);
  } catch (e) {
    console.error(`[monomem] could not restrict ${dir} to your account with icacls (${(e as Error).message}); other accounts on this PC may be able to read it. Fix: icacls "${dir}" /inheritance:r /grant:r "%USERDOMAIN%\\%USERNAME%:(OI)(CI)F" "SYSTEM:(OI)(CI)F" /remove:g ${WIDE_SIDS.join(" ")}`);
  }
}

