// Before any icacls lockdown (monomem check --setup --fix, monomem setup): is this folder really a Monomem data folder, and is it
// safe to strip every other account's access from it? The folder comes from MONOMEM_HOME / MONOMEM_DB_PATH, so a wrong value (a
// shared folder, a project, the home folder, a drive root) must not be locked, and a run under another account (runas, a service)
// must not lock the real user out. Returns the reason to refuse, or null.
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, parse, relative, resolve, isAbsolute } from "node:path";

/** A file Monomem itself creates in its data folder: one of these must be there. */
export const MARKER_FILES = ["state.db", "setup-history.json", ".token", "tokens.json", ".key", "audit.log"] as const;

export interface GuardOpts {
  env?: NodeJS.ProcessEnv;
  /** The account this process really runs as (test hook; default: the operating system's answer). */
  user?: string;
  home?: string;
}

const norm = (p: string): string => resolve(p).replace(/[\/]+$/, "").toLowerCase();

/** Is `child` the same as, or inside, `parent`? Lexical (no symlinks), case-insensitive: the Windows rule this is used for. */
export function isInside(parent: string, child: string): boolean {
  const r = relative(norm(parent), norm(child));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function actualUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

export function lockdownRefusal(dir: string, o: GuardOpts = {}): string | null {
  const env = o.env ?? process.env;
  const abs = resolve(dir);
  if (parse(abs).root.toLowerCase() === abs.toLowerCase() || /^[a-z]:[\/]?$/i.test(dir)) return `${dir} is a drive root`;
  const home = o.home ?? homedir();
  const profile = [home, env.USERPROFILE, dirname(home)].filter((p): p is string => !!p);
  if (profile.some((p) => norm(p) === norm(abs))) return `${dir} is a user profile folder, not a Monomem data folder`;
  const system = [env.SystemRoot, env.windir, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData].filter((p): p is string => !!p);
  if (system.some((p) => isInside(p, abs))) return `${dir} is a system folder`;
  if (!MARKER_FILES.some((f) => existsSync(join(abs, f)))) return `${dir} does not look like a Monomem data folder (none of ${MARKER_FILES.slice(0, 3).join(", ")} is in it)`;
  const named = env.USERNAME?.trim();
  const who = o.user ?? actualUser();
  if (named && who && named.toLowerCase() !== who.toLowerCase()) return `this program runs as ${who} but USERNAME says ${named}: locking the folder to ${named} could lock you out`;
  return null;
}
