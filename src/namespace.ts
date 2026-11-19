// Server-side namespace resolution.
//
// Closes a prompt-injection vector: when this feature is configured, the
// `namespace` parameter on MCP tools / the REST API is treated as untrusted
// (model-supplied) input. The server resolves the caller's namespace ONCE at
// startup from the process working directory (plus an explicit operator
// override), and that resolution is authoritative for the whole process:
// writes always land in the resolved namespace, reads are limited to the
// resolved namespace plus any namespaces it has been granted read access to.
//
// The feature is strictly opt-in and fail-open: if no namespace config is
// present (neither MONOMEM_SPACES nor <data dir>/spaces.json), everything behaves
// exactly as before -- model-supplied namespaces keep working. Resolution
// only activates when configured.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { DATA_DIR } from "./config.js";

/** Path of the spaces config file (in the data dir). */
export const SPACES_FILE = join(DATA_DIR, "spaces.json");

/** Shape of the namespace configuration (env JSON or <data dir>/spaces.json). */
export interface NamespaceConfig {
  /** Map of directory pattern -> namespace. See resolveNamespace for pattern semantics. */
  spaces: Record<string, string>;
  /** Fallback namespace when no space pattern matches the cwd. */
  default_namespace: string;
  /**
   * One-directional read grants: { "agent-a": ["shared"] } means namespace
   * "agent-a" may READ namespace "shared", but "shared" may NOT read
   * "agent-a". Writes ALWAYS go to the server's own resolved namespace,
   * grants never confer write access.
   */
  reads_from?: Record<string, string[]>;
}

/** Optional namespace-resolution wiring threaded through the server factories. */
export interface ServerNamespaceOpts {
  /** The server-resolved namespace (authoritative when set). */
  namespace?: string;
  /** One-directional read grants, as in NamespaceConfig.reads_from. */
  readsFrom?: Record<string, string[]>;
  /**
   * Which MCP tools to register, overriding MONOMEM_TOOLS. `"all"` registers
   * every tool. Used by the benchmark harness, which measures the whole
   * surface and must not depend on the ambient environment.
   */
  tools?: "all" | readonly string[];
}

const SPACES_ENV = "MONOMEM_SPACES";
const SPACE_OVERRIDE_ENV = "MONOMEM_SPACE";

/**
 * How paths compare on a platform. Windows and macOS filesystems are
 * case-insensitive by default, so both sides are lowercased there; paths
 * that exist are realpath'd (symlinks, 8.3 names, drive-letter case) when
 * resolving for the host platform. Mirrors invokedDirectly() in
 * mcp-http.ts.
 */
interface PathFlavor {
  path: typeof posix;
  foldCase: boolean;
  realpath: boolean;
}

function pathFlavor(platform: NodeJS.Platform = process.platform): PathFlavor {
  return {
    path: platform === "win32" ? win32 : posix,
    foldCase: platform === "win32" || platform === "darwin",
    realpath: platform === process.platform,
  };
}

/** Strip a trailing `*` (explicit prefix syntax) and surrounding space. */
function patternPath(raw: string): string {
  let p = raw.trim();
  if (p.endsWith("*")) p = p.slice(0, -1).trimEnd();
  return p;
}

/** Normalize separators and drop trailing slashes (the root is kept). */
function lexicalDir(dir: string, f: PathFlavor): string {
  let p = f.path.normalize(dir);
  const rootLen = f.path.parse(p).root.length;
  while (p.length > rootLen && (p.endsWith("/") || p.endsWith(f.path.sep))) {
    p = p.slice(0, -1);
  }
  return p;
}

/** Comparison form of a directory: realpath'd when it exists, case-folded where the FS is. */
function canonicalDir(dir: string, f: PathFlavor): string {
  let p = dir;
  if (f.realpath && p) {
    try {
      p = realpathSync(p);
    } catch {
      /* not on disk: compare lexically */
    }
  }
  p = lexicalDir(p, f);
  return f.foldCase ? p.toLowerCase() : p;
}

/**
 * Resolve the namespace for a working directory against a config.
 *
 * Pattern semantics (deliberately simple and explicit): a pattern is a
 * directory path. It matches that directory AND everything under it
 * (prefix semantics) -- so "/home/user/work" already covers
 * "/home/user/work/project". A trailing `*` is accepted as explicit
 * prefix syntax ("/home/user/work/*" behaves identically); it is not
 * required. Patterns should be absolute; a pattern that normalizes to
 * empty is ignored. Paths that exist are compared by realpath, and on
 * Windows and macOS (case-insensitive filesystems) case-insensitively;
 * `opts.platform` overrides the host platform (tests).
 *
 * Resolution order:
 *   1. MONOMEM_SPACE env var, if set and non-empty -- the explicit
 *      operator override always wins.
 *   2. The longest matching path pattern in cfg.spaces (compared by
 *      normalized pattern length, longest first).
 *   3. cfg.default_namespace.
 *
 * Overlap: if two patterns match the cwd with EQUAL match length (same
 * depth) but map to DIFFERENT namespaces, this throws -- ambiguous
 * configuration is a hard startup error, never a silent pick. Two
 * equal-depth patterns mapping to the SAME namespace are fine.
 */
export function resolveNamespace(
  cwd: string,
  cfg: NamespaceConfig,
  opts: { platform?: NodeJS.Platform } = {}
): string {
  const override = process.env[SPACE_OVERRIDE_ENV];
  if (override && override.trim()) return override.trim();

  const f = pathFlavor(opts.platform);
  const here = canonicalDir(cwd, f);
  const matches: Array<{ pattern: string; length: number; namespace: string }> = [];
  for (const [rawPattern, ns] of Object.entries(cfg.spaces)) {
    const stripped = patternPath(rawPattern);
    if (!stripped) continue; // degenerate pattern (e.g. just "*") -- ignore
    const pattern = canonicalDir(stripped, f);
    // A root pattern ("/", "C:\\") already ends in a separator.
    const prefix = pattern.endsWith(f.path.sep) ? pattern : pattern + f.path.sep;
    if (here === pattern || here.startsWith(prefix)) {
      matches.push({ pattern: stripped, length: pattern.length, namespace: ns });
    }
  }
  matches.sort((a, b) => b.length - a.length);
  const top = matches[0];
  if (!top) return cfg.default_namespace;
  for (const m of matches.slice(1)) {
    if (m.length === top.length && m.namespace !== top.namespace) {
      throw new Error(
        `monomem namespace overlap: "${m.pattern}" and "${top.pattern}" both match ` +
          `"${cwd}" at equal depth but map to different namespaces ` +
          `("${m.namespace}" vs "${top.namespace}"). Disambiguate the spaces config.`
      );
    }
  }
  return top.namespace;
}

function isNamespaceConfig(v: unknown): v is NamespaceConfig {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.default_namespace !== "string" || !o.default_namespace.trim()) return false;
  if (typeof o.spaces !== "object" || o.spaces === null || Array.isArray(o.spaces)) {
    return false;
  }
  for (const [k, val] of Object.entries(o.spaces as Record<string, unknown>)) {
    if (typeof k !== "string" || !k.trim()) return false;
    if (typeof val !== "string" || !val.trim()) return false;
  }
  if (o.reads_from !== undefined) {
    if (typeof o.reads_from !== "object" || o.reads_from === null || Array.isArray(o.reads_from)) {
      return false;
    }
    for (const arr of Object.values(o.reads_from as Record<string, unknown>)) {
      if (!Array.isArray(arr) || !arr.every((x) => typeof x === "string")) return false;
    }
  }
  return true;
}

/** Where a namespace config would come from: env wins over the file. */
export function namespaceConfigSource(): "env" | "file" | null {
  const raw = process.env[SPACES_ENV];
  if (raw && raw.trim()) return "env";
  if (existsSync(SPACES_FILE)) return "file";
  return null;
}

/**
 * Load the namespace config: MONOMEM_SPACES (a JSON string) wins if set,
 * otherwise <data dir>/spaces.json. Returns null when neither is present (feature
 * disabled -- legacy behavior). Invalid JSON or an invalid shape is logged
 * LOUDLY and returns null (fail-open to legacy behavior, never a silent
 * half-configured state).
 */
export function loadNamespaceConfig(): NamespaceConfig | null {
  const src = namespaceConfigSource();
  if (!src) return null;
  const where = src === "env" ? SPACES_ENV : SPACES_FILE;
  let parsed: unknown;
  try {
    const text = src === "env" ? (process.env[SPACES_ENV] as string) : readFileSync(SPACES_FILE, "utf8");
    parsed = JSON.parse(text);
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[monomem] ignoring namespace config (${where}): not valid JSON`);
    return null;
  }
  if (!isNamespaceConfig(parsed)) {
    // eslint-disable-next-line no-console
    console.error(
      `[monomem] ignoring namespace config (${where}): expected ` +
        `{ "spaces": { "<dir>": "<namespace>" }, "default_namespace": "<namespace>", ` +
        `"reads_from": { "<namespace>": ["<namespace>"] } }`
    );
    return null;
  }
  return parsed;
}

/** Namespaces this server may read: its own plus its one-directional grants (deduped). */
export function readableNamespaces(
  ownNamespace: string,
  grants?: Record<string, string[]>
): string[] {
  const extra = grants?.[ownNamespace] ?? [];
  const seen = new Set<string>([ownNamespace]);
  const out = [ownNamespace];
  for (const g of extra) {
    if (typeof g === "string" && g && !seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}

/** readableNamespaces() for a per-request NsCtx. */
export function readableIn(ctx: NsCtx): string[] {
  return ctx.active ? readableNamespaces(ctx.ownNamespace, ctx.readsFrom) : [];
}

/** canRead() for a per-request NsCtx. Always false when the ctx is disabled. */
export function ctxCanRead(ctx: NsCtx, targetNamespace: string): boolean {
  if (!ctx.active) return true; // no boundary: legacy permissive
  return canRead(ctx.readsFrom, ctx.ownNamespace, targetNamespace);
}

/**
 * Read-access check: a server resolved to `ownNamespace` may read `target`
 * when it IS its own namespace, or when its grants list the target.
 * Grants are one-directional: {"agent-a": ["shared"]} lets agent-a read
 * "shared", not the reverse.
 */
export function canRead(
  grants: Record<string, string[]> | undefined,
  ownNamespace: string,
  targetNamespace: string
): boolean {
  if (targetNamespace === ownNamespace) return true;
  return !!grants?.[ownNamespace]?.includes(targetNamespace);
}

/**
 * Configured space directory patterns (trailing `*` stripped) that do not
 * exist on disk -- surfaced by `monomem doctor` as warnings, since a
 * space pointing at a missing directory usually means a typo or a path
 * that only exists on another machine.
 */
export function validateSpacePaths(cfg: NamespaceConfig): string[] {
  const missing: string[] = [];
  for (const raw of Object.keys(cfg.spaces)) {
    const stripped = patternPath(raw);
    if (!stripped) continue;
    const p = lexicalDir(stripped, pathFlavor());
    if (!existsSync(p)) missing.push(p);
  }
  return missing;
}

export interface ResolvedNamespace {
  namespace: string;
  readsFrom: Record<string, string[]>;
}

/**
 * Per-REQUEST namespace context, resolved from the authenticated token plus
 * the server's startup config.
 *
 * This is what turns per-token namespace pins into real isolation. Before
 * this existed, `namespace` was a per-PROCESS constant (resolved once from
 * the cwd), so every token hitting one shared server saw the same namespace
 * -- scoped tokens gated ACTIONS (read/write/admin) but never WHICH
 * namespace. That is exactly the "shared memory every agent can read" hole.
 *
 * `active` mirrors the old `nsActive`: when false there is no boundary to
 * enforce and behavior is the legacy permissive one.
 */
export interface NsCtx {
  /** True when a namespace boundary must be enforced for this request. */
  active: boolean;
  /** The namespace this request may write to, and read without a grant. */
  ownNamespace: string;
  /** One-directional read grants, keyed by the GRANTOR namespace. */
  readsFrom: Record<string, string[]>;
}

/** No boundary: legacy permissive behavior (every note readable/writable). */
export const NS_DISABLED: NsCtx = { active: false, ownNamespace: "", readsFrom: {} };

/**
 * Resolve the namespace context for ONE request.
 *
 * Precedence, deliberately:
 *   1. The token's `namespace` pin, when present -- PER-TOKEN ISOLATION WINS.
 *      A pinned token is confined to its namespace no matter what the server
 *      resolved from its cwd. This is the property that makes one shared
 *      bridge safe for several agents.
 *   2. Otherwise the server's startup-resolved namespace (legacy behavior,
 *      fully backward compatible).
 *   3. Otherwise disabled.
 *
 * Grants (`reads_from`) are keyed by namespace and always come from the
 * server's operator-controlled config, never from the token: a token may say
 * WHERE it lives, but only the operator can say WHAT it may additionally
 * read. A pinned token's grants are therefore `grants[pinnedNamespace]` --
 * the operator grants access to a namespace, and any token pinned there
 * inherits it.
 */
export function resolveRequestNamespace(
  tokenNamespace: string | undefined,
  server: ResolvedNamespace | ServerNamespaceOpts | null | undefined
): NsCtx {
  const serverNs =
    server && typeof server.namespace === "string" && server.namespace.trim()
      ? server.namespace.trim()
      : undefined;
  const grants = server?.readsFrom ?? {};

  // 1. Token pin wins: this request is confined to the token's namespace.
  if (tokenNamespace && tokenNamespace.trim()) {
    const own = tokenNamespace.trim();
    return { active: true, ownNamespace: own, readsFrom: grants };
  }
  // 2. Server-resolved namespace applies to unpinned tokens.
  if (serverNs) {
    return { active: true, ownNamespace: serverNs, readsFrom: grants };
  }
  // 3. No boundary configured at all.
  return NS_DISABLED;
}

/**
 * Resolve the namespace ONCE at startup from the process working directory.
 * Returns null when no namespace config is present (feature disabled).
 * Throws on ambiguous overlap -- startup must fail loudly, never silently
 * pick a namespace.
 */
export function resolveStartupNamespace(cwd: string, opts: { auto?: boolean } = {}): ResolvedNamespace | null {
  const cfg = loadNamespaceConfig();
  if (cfg) return { namespace: resolveNamespace(cwd, cfg), readsFrom: cfg.reads_from ?? {} };
  // No spaces map: only a per-app stdio server or the session-start hook may scope itself to the repo it was started in
  // (opts.auto). The HTTP server and `monomem start` serve several agents from one folder and never do.
  return opts.auto ? resolveAutoScope(cwd) : null;
}

/** Per-project scope without a spaces map. MONOMEM_AUTO_SCOPE=1 / 0 wins; else the `auto-scope` file in the data dir says "on". */
export const AUTO_SCOPE_ENV = "MONOMEM_AUTO_SCOPE";
export const AUTO_SCOPE_FILE = join(DATA_DIR, "auto-scope");

let warnedBadScopeEnv = false;
export function autoScopeMode(): { on: boolean; source: "env" | "file" | "off"; invalid?: string } {
  const rawEnv = (process.env[AUTO_SCOPE_ENV] ?? "").trim();
  const env = rawEnv.toLowerCase();
  if (["1", "on", "true", "yes"].includes(env)) return { on: true, source: "env" };
  if (["0", "off", "false", "no"].includes(env)) return { on: false, source: "env" };
  // A value that is neither: say so once (a typo such as "ture" must not look like a deliberate "off"), then use the saved setting.
  const invalid = rawEnv ? rawEnv.slice(0, 40) : undefined;
  if (invalid && !warnedBadScopeEnv) {
    warnedBadScopeEnv = true;
    process.stderr.write(`[monomem] ${AUTO_SCOPE_ENV}="${invalid}" is not understood (use 1 for on or 0 for off), so it is ignored. The saved setting (monomem scope status) is used instead.\n`);
  }
  try {
    if (existsSync(AUTO_SCOPE_FILE) && readFileSync(AUTO_SCOPE_FILE, "utf8").trim().toLowerCase() === "on") return { on: true, source: "file", ...(invalid ? { invalid } : {}) };
  } catch {
    /* unreadable: stays off (the shared space, as before) */
  }
  return { on: false, source: "off", ...(invalid ? { invalid } : {}) };
}

/**
 * A folder whose `.git` is a FILE ("gitdir: <path>"): when that path is `<main>/.git/worktrees/<name>` the folder is a git
 * worktree and the answer is `<main>`, the repository it was made from (so both share notes). A submodule's gitdir is under
 * `.git/modules`, a bare repository has no working folder: those return null and the folder stays its own project.
 */
function worktreeMainRoot(dir: string, f: PathFlavor): string | null {
  let text: string;
  try {
    text = readFileSync(join(dir, ".git"), "utf8");
  } catch {
    return null; // `.git` is a folder (an ordinary repository) or unreadable
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  const gitdir = f.path.resolve(dir, m[1]);
  const worktrees = f.path.dirname(gitdir);
  const commonGit = f.path.dirname(worktrees);
  if (f.path.basename(worktrees) !== "worktrees" || f.path.basename(commonGit) !== ".git") return null;
  const main = f.path.dirname(commonGit);
  if (!existsSync(join(commonGit, "worktrees"))) return null;
  // What git itself requires: `<gitdir>/gitdir` must exist and point back at THIS folder's own `.git`. Without it any folder
  // could write a `.git` file naming someone else's repository and read that repository's notes (a forged worktree).
  try {
    const back = readFileSync(join(gitdir, "gitdir"), "utf8").split(/\r?\n/)[0].trim();
    if (!back || back.length > 4096 || back.includes("\0")) return null;
    const backPath = f.path.resolve(gitdir, back); // git may store this relative to the worktree's admin folder
    const same = (a: string, b: string): boolean => {
      const real = (p: string): string => {
        try {
          return realpathSync.native(p);
        } catch {
          return p;
        }
      };
      return canonicalDir(lexicalDir(real(a), f), f) === canonicalDir(lexicalDir(real(b), f), f);
    };
    if (!same(backPath, join(dir, ".git"))) return null;
  } catch {
    return null; // no back-pointer: not a real worktree, so the folder is its own project
  }
  try {
    return lexicalDir(realpathSync.native(main), f);
  } catch {
    return null; // the main repository is gone (a removed or moved folder): keep the worktree as its own project
  }
}

/**
 * The repository a folder belongs to: the nearest parent (or the folder itself) holding `.git`. A git worktree belongs to
 * the repository it was made from (its notes are that repository's notes); a submodule is its own project. null for the
 * home folder, a drive root, or a folder in no repository: those stay in the shared space, so an app launched outside any
 * project is not given a namespace from wherever it happened to start.
 */
export function findRepoRoot(cwd: string, home: string = homedir()): string | null {
  const f = pathFlavor();
  let real = cwd;
  try {
    real = realpathSync.native(cwd); // a folder reached through a symlink or junction is the same project as its real path
  } catch {
    /* not on disk: walk the path as given */
  }
  let dir = lexicalDir(real, f);
  const homeDir = canonicalDir(home, f);
  for (let i = 0; i < 64; i++) {
    const canon = canonicalDir(dir, f);
    if (canon === homeDir || dir === f.path.parse(dir).root) return null;
    if (existsSync(join(dir, ".git"))) {
      const main = worktreeMainRoot(dir, f);
      if (main !== null && canonicalDir(main, f) === homeDir) return null; // a worktree of a repository in the home folder: shared, like that repository
      return main ?? dir;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** `<folder name>-<6 hex of a hash of the repo's real path>`: readable, stable, and different for two repos with the same name. */
export function autoScopeName(root: string): string {
  const f = pathFlavor();
  const canon = canonicalDir(root, f);
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  return `${slug}-${createHash("sha256").update(canon).digest("hex").slice(0, 6)}`;
}

/** The repo-scoped namespace for a folder when auto-scope is on and the folder is in a repo; null otherwise. No read grants: repos are isolated. */
export function resolveAutoScope(cwd: string): ResolvedNamespace | null {
  if (!autoScopeMode().on) return null;
  const root = findRepoRoot(cwd);
  return root ? { namespace: autoScopeName(root), readsFrom: {} } : null;
}
