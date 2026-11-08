// Shared config: DB path + bearer token, used by the HTTP API, the stdio
// MCP server, and the HTTP/SSE MCP server so all three point at the same
// state file and accept the same token.

import "./legacy-env.js"; // first: CLAUDE_BRIDGE_* (the old name) are read as MONOMEM_*
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsc,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveTimeZone } from "./time-parse.js";
import { didYouMean } from "./suggest.js";
import { type Sensitivity, parseSensitivity, sensitivityRank, defaultCeilingFromEnv, SENSITIVITY_HELP } from "./sensitivity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..", "..");

/** Where 1.0.x kept its state: inside the package (lost on npm update / npx cache purge). */
/**
 * The real package version (package.json): reported by `monomem --version`
 * and the MCP serverInfo so clients see the build they are talking to.
 */
export const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export const LEGACY_DATA_DIR = join(PROJECT_ROOT, "data");

/** Where the store lived when this package was called OneMemory. */
export const LEGACY_HOME_DIR_NAME = ".onememory";
/** Where it lives now. */
export const HOME_DIR_NAME = ".monomem";

/**
 * The data directory (database, token, tokens.json, spaces.json):
 *   1. MONOMEM_HOME, when set (ONEMEMORY_HOME still works -- see legacy-env.ts);
 *   2. the package's own ./data, when running from a git checkout that
 *      already has ./data/state.db (a from-source install keeps working
 *      exactly as before);
 *   3. ~/.onememory, IF it already holds a store and ~/.monomem does not --
 *      the rename must never make an existing user's notes vanish, and
 *      silently starting them on an empty database would be exactly that;
 *   4. otherwise ~/.monomem (Windows: %USERPROFILE%\.monomem) -- outside the
 *      installed package, so updates never touch it.
 *
 * Rule 3 is the whole reason this function is not a one-liner. An existing
 * store always wins over the new default, and nothing is moved or copied:
 * the old directory is used in place, so downgrading to an older version
 * keeps working too.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  root: string = PROJECT_ROOT
): { dir: string; why: "env" | "checkout" | "home" | "legacy-home" } {
  const home = env.MONOMEM_HOME ?? env.ONEMEMORY_HOME;
  if (home && home.trim()) {
    return { dir: resolve(home.trim()), why: "env" };
  }
  if (existsSync(join(root, ".git")) && existsSync(join(root, "data", "state.db"))) {
    return { dir: join(root, "data"), why: "checkout" };
  }
  const newHome = join(homedir(), HOME_DIR_NAME);
  const oldHome = join(homedir(), LEGACY_HOME_DIR_NAME);
  if (!existsSync(join(newHome, "state.db")) && existsSync(join(oldHome, "state.db"))) {
    return { dir: oldHome, why: "legacy-home" };
  }
  return { dir: newHome, why: "home" };
}

const DATA = resolveDataDir();
export const DATA_DIR = DATA.dir;
/** Why DATA_DIR was chosen (doctor reports it). */
export const DATA_DIR_SOURCE = DATA.why;

export const DB_PATH = process.env.MONOMEM_DB_PATH || join(DATA_DIR, "state.db");

export const TOKEN_FILE = join(DATA_DIR, ".token");

/** True when `p` sits inside a node_modules tree (an installed package). */
export function insideNodeModules(p: string): boolean {
  return resolve(p).split(sep).includes("node_modules");
}

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

/** Create `dir` owner-only (0700) and re-tighten it if it already existed looser. */
export function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodQuiet(dir, 0o700);
}

/** The data-dir files that hold notes or credentials: owner read/write only. */
export const PRIVATE_FILES = ["state.db", "state.db-wal", "state.db-shm", "audit.log", ".token", "tokens.json", "spaces.json", ".key", ".attest-key"];

/**
 * Run fn holding an exclusive lock file (created with O_EXCL, so only one
 * process can hold it). Waits up to 30 s for another holder; a lock older
 * than 2 minutes is presumed left by a crashed process and removed.
 */
function withLockFile<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + 30_000;
  let lastCode: string | undefined;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      // Contention does not always surface as EEXIST. On Windows a file another
      // process has just rmSync'd stays in DELETE_PENDING until its last handle
      // closes, and opening it returns EPERM -- occasionally EBUSY or EACCES
      // when an AV scanner holds it. Rethrowing those aborted the migration
      // mid-way with a raw stack, which is exactly the "8 processes migrate +
      // write at once" failure that has been re-run away as a CI flake for
      // three releases. It is a real bug: several assistants starting together
      // on Windows IS the 8-process case, against the one-time legacy
      // migration. Treat all four as "someone else holds it, wait".
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
      lastCode = code;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 120_000) rmSync(lock, { force: true });
      } catch {
        /* holder just released it: retry */
      }
      // The 30 s deadline still terminates a genuinely unwritable directory;
      // naming the errno keeps that case diagnosable instead of looking like
      // ordinary contention.
      if (Date.now() > deadline) throw new Error(`another process is still migrating (lock file ${lock}, last error ${lastCode})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * One-time move of 1.0.x state from `from` (the package's ./data) to `to`
 * (the new data dir). Runs only when the old database exists and the new
 * one does not; the old files are left in place. The database is copied
 * with VACUUM INTO (a consistent snapshot that includes WAL content, even
 * if an old server is still running) into a temp file, then published with
 * a hard link -- never a replacing rename -- under an exclusive lock file,
 * so two processes starting at once can't swap the database under each
 * other. Returns human-readable lines describing what happened (empty =
 * nothing).
 */
export function migrateLegacyData(from: string, to: string): string[] {
  const oldDb = join(from, "state.db");
  const newDb = join(to, "state.db");
  if (resolve(from) === resolve(to) || !existsSync(oldDb) || existsSync(newDb)) return [];
  privateDir(to);
  return withLockFile(join(to, ".migrate.lock"), () => {
    if (existsSync(newDb)) return []; // another process migrated while we waited
    const tmp = `${newDb}.migrating-${process.pid}`;
    rmSync(tmp, { force: true });
    try {
      const src = new DatabaseSync(oldDb);
      try {
        src.exec("PRAGMA busy_timeout = 5000;");
        src.prepare("VACUUM INTO ?").run(tmp);
      } finally {
        src.close();
      }
      chmodQuiet(tmp, 0o600);
      try {
        linkSync(tmp, newDb);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return [];
        throw e;
      }
    } finally {
      rmSync(tmp, { force: true });
    }
    const out = [`copied database ${oldDb} -> ${newDb}`];
    for (const f of [".token", "tokens.json", "spaces.json"]) {
      const a = join(from, f);
      const b = join(to, f);
      if (existsSync(a) && !existsSync(b)) {
        copyFileSync(a, b, fsc.COPYFILE_EXCL);
        chmodQuiet(b, 0o600);
        out.push(`copied ${f}`);
      }
    }
    out.push(`the old copy in ${from} was left in place; delete it once you're happy`);
    return out;
  });
}

let prepared = false;

/**
 * Call once at startup, before opening the database: migrates 1.0.x state
 * out of the package into DATA_DIR (see migrateLegacyData) and says so on
 * stderr. Skipped when MONOMEM_DB_PATH pins the database explicitly.
 * Never throws: on failure it warns and the server starts on DATA_DIR.
 */
export function prepareDataDir(): void {
  if (prepared) return;
  prepared = true;
  // Owner-only data dir + files on every start (POSIX; no-op on Windows):
  // the dir may predate this release at 0755 and the files at 0644.
  try {
    privateDir(DATA_DIR);
    for (const f of PRIVATE_FILES) chmodQuiet(join(DATA_DIR, f), 0o600);
    // The encryption key lives beside the database or at MONOMEM_KEY_FILE.
    chmodQuiet(join(dirname(DB_PATH), ".key"), 0o600);
    if (process.env.MONOMEM_KEY_FILE) chmodQuiet(process.env.MONOMEM_KEY_FILE, 0o600);
    // The attestation signing key (a sync tool or a restore may have left it 0644) and any pre-upgrade copy of the database.
    if (process.env.MONOMEM_ATTEST_KEY_FILE) chmodQuiet(process.env.MONOMEM_ATTEST_KEY_FILE, 0o600);
    for (const f of readdirSync(dirname(DB_PATH))) {
      if (/^state\.db\.pre-v\d+-backup(\.\d+\.partial)?$/.test(f) || f === ".attest-key") chmodQuiet(join(dirname(DB_PATH), f), 0o600);
    }
  } catch {
    /* read-only or foreign-owned dir: hardening is best-effort */
  }
  if (process.env.MONOMEM_DB_PATH) return;
  // A client that sets a different MONOMEM_HOME than the one a previous run
  // used would otherwise start empty without a word.
  const homeDefault = join(homedir(), ".monomem");
  if (
    resolve(DATA_DIR) !== resolve(homeDefault) &&
    !existsSync(join(DATA_DIR, "state.db")) &&
    existsSync(join(homeDefault, "state.db"))
  ) {
    console.error(
      `[monomem] ${DATA_DIR} has no store yet, but ${homeDefault} does. ` +
        `To keep using it, unset MONOMEM_HOME or copy ${homeDefault} into ${DATA_DIR}.`
    );
  }
  try {
    const lines = migrateLegacyData(LEGACY_DATA_DIR, DATA_DIR);
    for (const l of lines) console.error(`[monomem] data migration: ${l}`);
  } catch (e) {
    console.error(
      `[monomem] data migration from ${LEGACY_DATA_DIR} failed: ${(e as Error).message}. ` +
        `Copy state.db and .token into ${DATA_DIR} by hand, or set MONOMEM_HOME=${LEGACY_DATA_DIR}.`
    );
  }
}

/**
 * Resolve the bearer token: env var wins; otherwise read/create a token
 * file on disk so the token is stable across restarts without forcing the
 * operator to set an env var every time.
 */
/** Shortest user-supplied bearer token accepted (generated tokens are 64 hex). */
export const MIN_TOKEN_LENGTH = 32;

export function resolveToken(): string {
  if (process.env.MONOMEM_TOKEN && process.env.MONOMEM_TOKEN.trim()) {
    const t = process.env.MONOMEM_TOKEN.trim();
    if (t.length < MIN_TOKEN_LENGTH) {
      throw new Error(
        `monomem: MONOMEM_TOKEN is too short (${t.length} chars); use at least ${MIN_TOKEN_LENGTH}. ` +
          `Make one with: monomem token new (it only prints a fresh value; nothing is saved)`
      );
    }
    return t;
  }
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("hex");
  privateDir(dirname(TOKEN_FILE));
  writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  // Never print the token value itself -- this line may be captured by a
  // Windows Scheduled Task's redirected output, a service manager's logs, or
  // future log-shipping, and the token is a full-access credential valid
  // over the public tunnel. Reference only the file path it was saved to.
  // eslint-disable-next-line no-console
  console.error(`[monomem] Generated new bearer token, saved to ${TOKEN_FILE}`);
  return token;
}

/**
 * Access scopes, least to most powerful:
 *   read  -> read/search/list
 *   write -> read + create/update
 *   admin -> write + delete + import + full /export  (primary token is admin)
 */
export type Scope = "read" | "write" | "admin";

export interface TokenEntry {
  token: string;
  scope: Scope;
  label: string;
  /**
   * Optional per-token namespace pin (PERMISSIONS, not decoration).
   *
   * When set, this token is confined to `namespace` for EVERY request,
   * regardless of the server's own cwd-resolved namespace. That is what makes
   * one shared bridge safe for several agents: token A in "work" and token B
   * in "personal" cannot read or write each other's notes even though they
   * hit the same server process.
   *
   * When unset, the token inherits the server's startup-resolved namespace
   * exactly as before (full backward compatibility). The primary token never
   * carries one -- it stays the operator's unrestricted escape hatch.
   */
  namespace?: string;
  /**
   * Optional per-token sensitivity CEILING (`public` < `internal` < `private`).
   *
   * When set, this token can never read a note labelled above it, on any note path
   * (search, recall, list, get, change feed, injection, export), can
   * not write a note above it, and can not touch a note above it. A hidden note
   * answers exactly like a note that does not exist. A non-admin token may raise
   * a note's label (up to its ceiling) but not lower it.
   *
   * When unset the token is not restricted by label (legacy behaviour, so existing
   * token files keep working); the docs recommend setting one on every secondary
   * token. The primary token never carries one.
   */
  max_sensitivity?: Sensitivity;
}

function isScope(s: unknown): s is Scope {
  return s === "read" || s === "write" || s === "admin";
}

/**
 * All accepted bearer tokens with their scope. The primary token
 * (MONOMEM_TOKEN or <data dir>/.token) is always admin, so single-token
 * setups behave exactly as before. Extra scoped tokens are optional and come
 * from MONOMEM_TOKENS (a JSON array) and/or a <data dir>/tokens.json file,
 * each entry { "token": "...", "scope": "read|write|admin", "label": "...",
 * "namespace": "..." }. `namespace` optionally PINS that token to one
 * namespace (see TokenEntry.namespace) -- per-token isolation on a shared
 * server. The primary token never carries a namespace pin.
 * Invalid or duplicate entries are skipped rather than failing startup.
 */
const SCOPE_RANK: Record<Scope, number> = { read: 1, write: 2, admin: 3 };

export function resolveTokens(): TokenEntry[] {
  // Tokens with at least one invalid entry. A token listed twice where ANY entry is invalid is refused entirely: the invalid
  // entry may be the stricter one, and the valid one must not quietly stand in for it.
  const refused = new Set<string>();
  const byToken = new Map<string, TokenEntry>();
  const locked = new Set<string>(); // the primary admin token's scope is fixed
  const add = (
    token: unknown,
    scope: unknown,
    label: unknown,
    lock = false,
    namespace?: unknown,
    maxSensitivity?: unknown
  ): void => {
    if (typeof token !== "string" || !token.trim()) return;
    const t = token.trim();
    if (!isScope(scope)) {
      // A misspelt scope used to drop the token without a word; say so, and suggest the likely word.
      const guess = typeof scope === "string" ? didYouMean(scope, ["read", "write", "admin"]) : null;
      console.error(
        `[monomem] ignoring token ${typeof label === "string" && label ? `"${label}"` : "(unnamed)"}: ` +
          `its "scope" must be read, write or admin (got ${JSON.stringify(scope)}).${guess ? ` Did you mean "${guess}"?` : ""} ` +
          `Fix the entry in MONOMEM_TOKENS / tokens.json; the token will not work until then.`
      );
      refused.add(t);
      return;
    }
    if (!lock && t.length < MIN_TOKEN_LENGTH) {
      console.error(
        `[monomem] ignoring token ${typeof label === "string" && label ? `"${label}"` : "(unnamed)"}: ` +
          `it is ${t.length} characters; user-supplied tokens must be at least ${MIN_TOKEN_LENGTH}. ` +
          `To add an app, let Monomem make the token for you: monomem token add <name>`
      );
      return;
    }
    // A namespace pin is only honored when it is a non-empty string. Trimmed
    // here so "  work  " and "work" are the same pin (a mismatch would be a
    // silent isolation hole, not a cosmetic diff).
    // FAIL CLOSED: a pin that is present but not a non-empty string (5, "",
    // [], {}) used to degrade silently to "unpinned" -- a token meant to be
    // confined became unrestricted. Reject the whole token instead, loudly.
    if (namespace !== undefined && namespace !== null && (typeof namespace !== "string" || !namespace.trim())) {
      console.error(
        `[monomem] ignoring token ${typeof label === "string" && label ? `"${label}"` : "(unnamed)"}: ` +
          `its "namespace" must be a non-empty string (got ${JSON.stringify(namespace)}). ` +
          `Fix the entry in MONOMEM_TOKENS / tokens.json; the token will not work until then.`
      );
      refused.add(t);
      return;
    }
    const ns = typeof namespace === "string" ? namespace.trim() : undefined;
    // A sensitivity ceiling is a restriction, so a value that is present but not a label (a typo such as "privte", 5, "")
    // must NOT quietly become "no ceiling": the whole token is refused, loudly, like a bad namespace pin.
    let ceiling: Sensitivity | undefined;
    // (`null` is also refused: it reads like "no limit", which is the opposite of what a ceiling is for.)
    if (maxSensitivity !== undefined) {
      const parsed = parseSensitivity(maxSensitivity);
      if (!parsed || lock) {
        refused.add(t);
        console.error(
          `[monomem] ignoring token ${typeof label === "string" && label ? `"${label}"` : "(unnamed)"}: ` +
            (lock
              ? `the primary token cannot carry a "max_sensitivity".`
              : `its "max_sensitivity" must be ${SENSITIVITY_HELP} (got ${JSON.stringify(maxSensitivity)}). `) +
            `Fix the entry in MONOMEM_TOKENS / tokens.json; the token will not work until then.`
        );
        return;
      }
      ceiling = parsed;
    }
    const existing = byToken.get(t);
    if (existing && locked.has(t) && ceiling !== undefined) {
      console.error(`[monomem] the primary token is also listed${typeof label === "string" && label ? ` as "${label}"` : ""} with a "max_sensitivity"; the primary token cannot carry one, so it is ignored and the primary token stays unrestricted.`);
    }
    if (existing) {
      // Never downgrade/change the primary token. For any other token listed
      // more than once, keep the MOST restrictive scope (lowest rank) AND the
      // most restrictive namespace: a pin always beats no pin, and on a
      // genuine conflict (two different pins) keep the first and warn -- an
      // ambiguous pin must never silently widen to "no pin".
      if (!locked.has(t)) {
        const scopeDown = SCOPE_RANK[scope] < SCOPE_RANK[existing.scope];
        const pinTighter = ns !== undefined && existing.namespace === undefined;
        // Same rule for the ceiling: the lower one wins, and any ceiling beats none.
        const ceilTighter =
          ceiling !== undefined &&
          (existing.max_sensitivity === undefined || sensitivityRank(ceiling) < sensitivityRank(existing.max_sensitivity));
        if (scopeDown || pinTighter || ceilTighter) {
          const nextNs = pinTighter ? ns : existing.namespace;
          const nextCeil = ceilTighter ? ceiling : existing.max_sensitivity;
          if (ns !== undefined && existing.namespace !== undefined && ns !== existing.namespace) {
            console.error(
              `[monomem] token ${existing.label || "(unnamed)"} is listed with two different ` +
                `namespaces ("${existing.namespace}" and "${ns}"); keeping "${existing.namespace}"`
            );
          }
          byToken.set(t, {
            token: t,
            scope: scopeDown ? scope : existing.scope,
            label: scopeDown && typeof label === "string" ? label : existing.label,
            ...(nextNs !== undefined ? { namespace: nextNs } : {}),
            ...(nextCeil !== undefined ? { max_sensitivity: nextCeil } : {}),
          });
        } else if (ns !== undefined && existing.namespace !== undefined && ns !== existing.namespace) {
          console.error(
            `[monomem] token ${existing.label || "(unnamed)"} is listed with two different ` +
              `namespaces ("${existing.namespace}" and "${ns}"); keeping "${existing.namespace}"`
          );
        }
      }
      return;
    }
    byToken.set(t, {
      token: t,
      scope,
      label: typeof label === "string" ? label : "",
      ...(ns !== undefined ? { namespace: ns } : {}),
      ...(ceiling !== undefined ? { max_sensitivity: ceiling } : {}),
    });
    if (lock) locked.add(t);
  };

  // Primary token is always admin (keeps single-token setups unchanged).
  try {
    add(resolveToken(), "admin", "primary", true);
  } catch (e) {
    if (/MONOMEM_TOKEN is too short/.test((e as Error).message)) throw e;
    /* no primary token available (e.g. doctor on a fresh box) */
  }

  const parseList = (raw: string, where: string): void => {
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      console.error(`[monomem] ignoring ${where}: not valid JSON`);
      return;
    }
    if (!Array.isArray(arr)) {
      console.error(
        `[monomem] ignoring ${where}: expected a JSON array of { token, scope, label }`
      );
      return;
    }
    for (const e of arr) {
      const o = e as { token?: unknown; scope?: unknown; label?: unknown; namespace?: unknown; max_sensitivity?: unknown };
      // A misspelt ceiling key ("maxSensitivity", "max_sensitivty") would otherwise be ignored and leave the token unrestricted.
      const lookalikes = o && typeof o === "object" ? Object.keys(o).filter((k) => k !== "max_sensitivity" && /sens|ceil/i.test(k)) : [];
      if (lookalikes.length) {
        console.error(
          `[monomem] ignoring token ${typeof o.label === "string" && o.label ? `"${o.label}"` : "(unnamed)"}: unknown key ${lookalikes.map((k) => JSON.stringify(k)).join(", ")} looks like "max_sensitivity". ` +
            `Fix the spelling in ${where}; the token will not work until then.`
        );
        if (typeof o.token === "string") refused.add(o.token.trim());
        continue;
      }
      // "primary" is the main key's name: another key carrying it would be treated as the unrestricted main key.
      if (typeof o?.label === "string" && o.label.trim().toLowerCase() === "primary" && typeof o.token === "string" && !locked.has(o.token.trim())) {
        console.error(`[monomem] ignoring a token in ${where}: the name "primary" is reserved for the main key. Rename it (monomem token add <name> makes a new one).`);
        refused.add(o.token.trim());
        continue;
      }
      add(o?.token, o?.scope, o?.label, false, o?.namespace, o?.max_sensitivity);
    }
  };

  if (process.env.MONOMEM_TOKENS && process.env.MONOMEM_TOKENS.trim()) {
    parseList(process.env.MONOMEM_TOKENS, "MONOMEM_TOKENS");
  }
  const tokensFile = join(DATA_DIR, "tokens.json");
  if (existsSync(tokensFile)) {
    parseList(readFileSync(tokensFile, "utf8"), tokensFile);
  }

  for (const t of refused) if (!locked.has(t)) byToken.delete(t);
  // Opt-in default ceiling for secondary tokens that set none. A value that is not a label stops the server (fail closed).
  const dflt = defaultCeilingFromEnv();
  if (dflt === null) {
    throw new Error(`MONOMEM_DEFAULT_MAX_SENSITIVITY must be ${SENSITIVITY_HELP} (got ${JSON.stringify(process.env.MONOMEM_DEFAULT_MAX_SENSITIVITY)})`);
  }
  if (dflt !== undefined) {
    for (const [t, e] of byToken) if (!locked.has(t) && e.max_sensitivity === undefined) byToken.set(t, { ...e, max_sensitivity: dflt });
  }
  return [...byToken.values()];
}

/**
 * Hot reload of <data dir>/tokens.json. `tokens` is the live array the servers authenticate against (both HTTP front doors
 * build a fresh server per request, so a change applies to the very next request): when the file changes, the list is
 * re-read and replaced IN PLACE. A removed token stops working at once; a changed ceiling applies to the next request.
 * A file that cannot be parsed keeps the old list (and says so), so a half-saved edit cannot lock everyone out or open it up.
 * Returns the function that checks now (used by tests) and a stop function.
 */
export function startTokenReload(tokens: TokenEntry[], opts: { intervalMs?: number; file?: string; log?: (m: string) => void } = {}): { check: () => boolean; stop: () => void } {
  const file = opts.file ?? join(DATA_DIR, "tokens.json");
  const log = opts.log ?? ((m: string) => console.error(m));
  const sig = (): string => {
    try {
      const st = statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "none";
    }
  };
  let last = sig();
  const check = (): boolean => {
    const now = sig();
    if (now === last) return false;
    last = now;
    try {
      // resolveTokens() skips a broken file with a log line; for a reload that would silently revoke everyone, so check first.
      if (now !== "none") {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("expected a JSON list");
      }
      const fresh = resolveTokens();
      tokens.splice(0, tokens.length, ...fresh);
      log(`[monomem] tokens reloaded: ${fresh.length} token(s) now accepted`);
      return true;
    } catch (e) {
      log(`[monomem] tokens.json changed but could not be read (${(e as Error).message}); keeping the previous list`);
      return false;
    }
  };
  const timer = setInterval(check, opts.intervalMs ?? 2000);
  timer.unref();
  return { check, stop: () => clearInterval(timer) };
}

// Parse a port from the environment, falling back (loudly) on anything that
// isn't a valid 1-65535 integer so a typo can't make listen() pick a random port.
function parsePort(envVal: string | undefined, def: number): number {
  if (!envVal) return def;
  const n = Number(envVal);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[monomem] invalid port "${envVal}"; falling back to ${def}`);
    return def;
  }
  return n;
}

export const API_PORT = parsePort(process.env.MONOMEM_PORT, 8790);
export const MCP_HTTP_PORT = parsePort(process.env.MONOMEM_MCP_PORT, 8791);

// Bind to loopback by default. Public exposure is opt-in and is expected to
// sit behind an authenticated tunnel (e.g. Cloudflare Tunnel + Access).
export const BIND_HOST = process.env.MONOMEM_BIND || "127.0.0.1";

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Parse a human interval like "24h", "30m", "90s", or a bare number of
 * seconds ("3600") into milliseconds. Returns null for anything else
 * (empty, garbage, negative). Bare numbers mean seconds — that matches how
 * operators already write timeout-ish env vars.
 */
export function parseIntervalToMs(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(n * mult[m[2] ?? "s"]);
}

/**
 * How often the background auto-consolidation runs (see start.ts). Unset =
 * off. The scheduler only auto-merges near-identical pairs (score >= 0.99);
 * weaker candidates are logged for review, never merged blindly.
 */
export const AUTO_CONSOLIDATE_INTERVAL_MS = parseIntervalToMs(
  process.env.MONOMEM_AUTO_CONSOLIDATE_INTERVAL
);

/**
 * Fail closed: never open a non-loopback listener without an explicit token.
 * An auto-generated token is fine for a local-only server, but if the
 * operator binds to a public interface they must set MONOMEM_TOKEN
 * deliberately rather than relying on an auto-minted one.
 */
export function assertSafeExposure(): void {
  // Read the bind host from the environment here (not the cached BIND_HOST
  // constant) so this guard reflects the actual configured bind and stays
  // unit-testable. Default matches BIND_HOST.
  const bind = process.env.MONOMEM_BIND || "127.0.0.1";
  const hasExplicitToken = !!(
    process.env.MONOMEM_TOKEN && process.env.MONOMEM_TOKEN.trim()
  );
  if (!isLoopback(bind) && !hasExplicitToken) {
    throw new Error(
      "Refusing to bind to a non-loopback address without MONOMEM_TOKEN set. " +
        "Set an explicit token, or keep the default localhost bind and expose it " +
        "through an authenticated tunnel (see INFRA.md)."
    );
  }
}

/**
 * IANA timezone used to interpret natural-language time phrases
 * ("yesterday", "last week") in time-aware search. Set MONOMEM_TIMEZONE,
 * e.g. MONOMEM_TIMEZONE=America/Winnipeg; unset, the host's system
 * timezone is used. Invalid names log to stderr and fall back to "UTC"
 * (never throw at import time).
 */
export const TIME_ZONE = resolveTimeZone(process.env.MONOMEM_TIMEZONE);

/**
 * Staleness detection (time-aware memory): notes older than these thresholds
 * (by updated_at, i.e. the most recent write wins) are flagged stale so
 * agents verify them before acting on outdated facts. Stale notes are never
 * hidden or deleted -- they are annotated (stale/ageDays/staleWarning) and
 * ranked slightly lower in search.
 */
export interface StalenessConfig {
  /** Days after which any note is stale. */
  staleDays: number;
  /** Tags that expire faster (compared with or without a leading "#"). */
  staleTags: string[];
  /** Days after which a note carrying a stale tag is stale. */
  staleTagDays: number;
}

function parsePositiveDays(raw: string | undefined, def: number): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : def;
}

function parseTagList(raw: string | undefined, def: string): string[] {
  const tags = (raw ?? def)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length ? tags : [def];
}

/**
 * Read the staleness thresholds from the environment (read at call time so
 * operators can change them without a restart of the importing module, and
 * so tests can override them). Invalid values fall back to the defaults.
 */
export function stalenessConfig(): StalenessConfig {
  return {
    staleDays: parsePositiveDays(process.env.MONOMEM_STALE_DAYS, 90),
    staleTags: parseTagList(process.env.MONOMEM_STALE_TAGS, "#status"),
    staleTagDays: parsePositiveDays(process.env.MONOMEM_STALE_TAG_DAYS, 30),
  };
}
