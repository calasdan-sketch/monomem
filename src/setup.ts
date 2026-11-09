// `monomem setup`: connect Monomem to Claude Code, Claude Desktop, Cursor, Codex CLI, Gemini CLI, Muse, VS Code and Zed
// without hand-editing JSON (or TOML, for Codex).
//
// The promises, in the order a nervous person would ask for them:
//   * It shows a plain-language plan and the exact lines it will change BEFORE touching anything (`--dry-run` stops there).
//   * It writes only after you type y (`--yes` skips the question; the backup is made either way).
//   * Every file it changes is copied first (<file>.monomem-backup-<time>) and written atomically (temp file + rename).
//   * It changes ONLY the Monomem entry. Other servers, other settings, comments, number formats, line endings and
//     key order stay byte for byte as they were (see jsonc-edit.ts). Nothing is ever deleted except the old
//     "claude-bridge" entry you agree to migrate; the old install folder and its database are never touched.
//   * `setup --undo` puts it back.
// Files are re-read right before the write and the edit is re-applied to what is there NOW, because Claude Code rewrites
// ~/.claude.json while it runs; a change made in between is kept, not overwritten.

import { copyFileSync, existsSync, rmSync, writeFileSync, fsyncSync, closeSync, openSync, mkdirSync, readFileSync, lstatSync, realpathSync, renameSync, statSync, unlinkSync, writeSync, chmodSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { applyOps, getMember, getPath, JsonEditError, opsAreApplied, parseDoc, parseJsonc, type Op } from "./jsonc-edit.js";
import { applyTomlOps, findTable, hasServer, tomlOpsApplied } from "./toml-table.js";

// ---- environment (injectable, so tests never touch a real configuration) ---------------------------------------------

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  /** The process environment (APPDATA, CLAUDE_CONFIG_DIR, MONOMEM_*). */
  env: NodeJS.ProcessEnv;
  cwd: string;
  nodeVersion: string;
  execPath: string;
  /** Absolute path of this package's cli.js. */
  cliPath: string;
  version: string;
  now: () => Date;
  /**
   * A global `npm i -g monomem` of THIS version (a stable cli.js path). Only looked for when setup runs from the npx cache:
   * undefined = not looked up yet, null = looked up and not found.
   */
  globalCliPath?: string | null;
}

/** Expand Windows 8.3 short names (PROGRA~1) and symlinks to the real long path; keep the input if that is impossible. */
export function longPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function realEnv(version: string, cliPath: string): SetupEnv {
  return {
    home: homedir(),
    platform: process.platform,
    env: process.env,
    cwd: process.cwd(),
    nodeVersion: process.versions.node,
    execPath: longPath(process.execPath),
    cliPath: longPath(cliPath),
    version,
    now: () => new Date(),
  };
}

export interface SetupIO {
  out(line: string): void;
  err(line: string): void;
  /** Ask a question; resolves with the typed answer. */
  ask(prompt: string): Promise<string>;
  interactive: boolean;
}

export interface SetupOptions {
  dryRun: boolean;
  yes: boolean;
  undo: boolean;
  /** "ask" (default), "yes" (--hook), "no" (--no-hook). */
  hook: "ask" | "yes" | "no";
  /** Automatic memory hooks: "ask" (default), "yes" (--capture), "no" (--no-capture). */
  capture?: "ask" | "yes" | "no";
  /** Restrict to these clients (CLIENT_IDS). */
  only?: string[];
  /** Also add to ./.mcp.json in the current folder. */
  project: boolean;
  /** Use this database for the new entry (default: the standard one, or the old one when migrating). */
  db?: string;
  /** A data folder other than ~/.monomem (from MONOMEM_HOME in this shell): written into each app entry's env too. */
  home?: string;
  noTestNote: boolean;
  noDoctor: boolean;
  /** "auto" (default), "node" (absolute node + cli.js) or "npx". */
  command: "auto" | "node" | "npx";
  /** Wire the app to the running HTTP server with its own key (so its sensitivity limit applies) instead of the stdio command. */
  httpEntry?: { url: string; headers: Record<string, string> };
  /** `connect` calls setup for one app: skip the version banner and the list of every app found. */
  terse?: boolean;
  /** Replace a config file that exists but is completely empty (0 bytes), which may be a half-written one. */
  forceEmpty: boolean;
  /** Remove an old (`onememory` / `claude-bridge`) entry that sits beside a `monomem` one. Only ever set after a typed yes. */
  removeOld?: boolean;
}

export const DEFAULT_OPTIONS: SetupOptions = { dryRun: false, yes: false, undo: false, hook: "ask", project: false, noTestNote: false, noDoctor: false, command: "auto", forceEmpty: false };

const EMPTY_FILE_MSG = (file: string): string =>
  `${file} exists but is completely empty (0 bytes). A program may have been cut off while saving it, and replacing it could lose settings. Look for a backup next to it, or if you are sure it is empty run setup again with --force-empty.`;

export const CLIENT_IDS = ["claude-code", "claude-desktop", "cursor", "codex", "gemini", "muse", "vscode", "zed", "project"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

// ---- detection ---------------------------------------------------------------------------------------------------------

export interface ClientTarget {
  id: ClientId;
  label: string;
  file: string;
  exists: boolean;
  /** The app looks installed (its config folder exists) even when the file does not yet. */
  present: boolean;
}

export function claudeDir(e: SetupEnv): string {
  const c = e.env.CLAUDE_CONFIG_DIR?.trim();
  return c ? resolve(c) : join(e.home, ".claude");
}

const appData = (e: SetupEnv): string => e.env.APPDATA?.trim() || join(e.home, "AppData", "Roaming");
const xdgConfig = (e: SetupEnv): string => e.env.XDG_CONFIG_HOME?.trim() || join(e.home, ".config");
export const codexDir = (e: SetupEnv): string => (e.env.CODEX_HOME?.trim() ? resolve(e.env.CODEX_HOME.trim()) : join(e.home, ".codex"));

export function detectClients(e: SetupEnv): ClientTarget[] {
  const out: ClientTarget[] = [];
  const cfgDir = e.env.CLAUDE_CONFIG_DIR?.trim();
  const ccFile = cfgDir ? join(resolve(cfgDir), ".claude.json") : join(e.home, ".claude.json");
  out.push({ id: "claude-code", label: "Claude Code", file: ccFile, exists: existsSync(ccFile), present: existsSync(ccFile) || existsSync(claudeDir(e)) });
  let desk: string;
  if (e.platform === "win32") desk = join(appData(e), "Claude", "claude_desktop_config.json");
  else if (e.platform === "darwin") desk = join(e.home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  else desk = join(xdgConfig(e), "Claude", "claude_desktop_config.json");
  out.push({ id: "claude-desktop", label: "Claude Desktop", file: desk, exists: existsSync(desk), present: existsSync(desk) || existsSync(dirname(desk)) });
  const cur = join(e.home, ".cursor", "mcp.json");
  out.push({ id: "cursor", label: "Cursor", file: cur, exists: existsSync(cur), present: existsSync(cur) || existsSync(dirname(cur)) });
  const add = (id: ClientId, label: string, file: string, dir = dirname(file)): void => void out.push({ id, label, file, exists: existsSync(file), present: existsSync(file) || existsSync(dir) });
  add("codex", "Codex CLI", join(codexDir(e), "config.toml"));
  add("gemini", "Gemini CLI", join(e.home, ".gemini", "settings.json"));
  // Muse documents only ~/.config/muse (or $XDG_CONFIG_HOME/muse); on Windows it runs under WSL2, so a native Windows
  // path is unverified and the same ~/.config path is used.
  add("muse", "Muse", join(xdgConfig(e), "muse", "settings.json"));
  add("vscode", "VS Code", join(e.platform === "win32" ? appData(e) : e.platform === "darwin" ? join(e.home, "Library", "Application Support") : xdgConfig(e), "Code", "User", "mcp.json"));
  add("zed", "Zed", e.platform === "win32" ? join(appData(e), "Zed", "settings.json") : join(xdgConfig(e), "zed", "settings.json"));
  const proj = join(e.cwd, ".mcp.json");
  out.push({ id: "project", label: "This folder's .mcp.json", file: proj, exists: existsSync(proj), present: existsSync(proj) });
  return out;
}

// ---- the entry we write ------------------------------------------------------------------------------------------------

export interface ServerEntry {
  type?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  [k: string]: unknown;
}

/** Is this process running from the npx cache (which is deleted from time to time)? */
export function runningFromNpxCache(cliPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(cliPath);
}

/** Hooks that run on every prompt / every Read: the agent waits for them, so their start-up time is felt each time. */
const SYNC_HOOK_EVENTS: ReadonlySet<string> = new Set(["user-prompt", "file-context"]);

/** Marker file (in the data folder) that setup writes when the person said no to the Claude Code hook, so `monomem health` can say so. */
export const HOOKS_DECLINED_FILE = "setup-hooks-declined";

/** From the npx cache: is the same version also installed globally? Returns that cli.js, a path that is not deleted from time to time. */
export function detectGlobalCli(e: SetupEnv): string | undefined {
  try {
    const r = spawnSync("npm", ["root", "-g"], { encoding: "utf8", shell: e.platform === "win32", timeout: 15_000 });
    const root = r.status === 0 ? (String(r.stdout).trim().split("\n").pop() ?? "").trim() : "";
    if (!root) return undefined;
    const pkg = join(root, "monomem");
    const cli = join(pkg, "dist", "src", "cli.js");
    const v = (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version?: string }).version;
    return v === e.version && existsSync(cli) ? longPath(cli) : undefined;
  } catch {
    return undefined;
  }
}

/** True when the hooks for the person and the agent wait on would go through npx (about 1 s slower on every prompt and every Read). */
export function syncHooksUseSlowNpx(e: SetupEnv, opts: Pick<SetupOptions, "command">): boolean {
  return (opts.command === "npx" || (opts.command === "auto" && runningFromNpxCache(e.cliPath))) && !(opts.command === "auto" && e.globalCliPath);
}

export const NPX_LATENCY_NOTE = (version: string): string =>
  "Speed: you started setup with npx, so the hooks that run on every prompt and every file read would go through npx too. " +
  "That adds about 1 to 1.5 seconds to each prompt and each read (a direct install adds under 0.4 s). Two choices:\n" +
  `    (a) recommended: run  npm i -g monomem@${version}  and then run  monomem setup  again; the hooks then run the installed copy.\n` +
  "    (b) keep npx and accept the delay on every prompt and read (the background hooks are not affected).\n" +
  "  I do not install anything for you.";

const CLIENT_LABEL: Record<string, string> = { "claude-code": "Claude Code", "claude-desktop": "Claude Desktop", cursor: "Cursor", codex: "Codex", gemini: "Gemini CLI", muse: "Muse", vscode: "VS Code", zed: "Zed" };

/** "Claude Code and Cursor": the apps whose files setup is about to change (a running app can rewrite its own file). */
export function closeList(ids: string[]): string {
  const names = [...new Set(ids)].map((i) => CLIENT_LABEL[i]).filter((n): n is string => !!n);
  if (!names.length) return "the assistants you are connecting";
  return names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

export function buildServerEntry(e: SetupEnv, opts: Pick<SetupOptions, "command">, env?: Record<string, string>, withType = false): ServerEntry {
  const useNpx = opts.command === "npx" || (opts.command === "auto" && runningFromNpxCache(e.cliPath));
  let entry: ServerEntry;
  if (useNpx) {
    // Pinned to this version on purpose: a database upgrade is one-way, so it must be a choice, not a side effect of npx.
    const pkg = `monomem@${e.version}`;
    // On native Windows, npx is a .cmd script, so a config usually needs it wrapped as `cmd /c npx`. This is commonly needed;
    // the Claude Code MCP docs do not state it (checked), so it is not confirmed there. Verify with `/mcp` after setup.
    entry = e.platform === "win32" ? { command: "cmd", args: ["/c", "npx", "-y", pkg, "mcp"] } : { command: "npx", args: ["-y", pkg, "mcp"] };
  } else {
    // Absolute node + absolute cli.js: nothing depends on PATH, and it is the same on every OS.
    entry = { command: e.execPath, args: [e.cliPath, "mcp"] };
  }
  if (withType) entry = { type: "stdio", ...entry };
  if (env && Object.keys(env).length) entry.env = env;
  return entry;
}

/** The command a hook runs (a shell runs it, so: bare `node`, forward slashes, quoted path). */
export function buildHookCommand(e: SetupEnv, opts: Pick<SetupOptions, "command">, dbPath?: string): string {
  const useNpx = opts.command === "npx" || (opts.command === "auto" && runningFromNpxCache(e.cliPath));
  const db = dbPath ? ` --db "${dbPath.replace(/\\/g, "/")}"` : "";
  if (useNpx) return `npx -y monomem@${e.version} recall --budget-ms 800${db}`;
  return `node "${e.cliPath.replace(/\\/g, "/")}" recall --budget-ms 800${db}`;
}

/** Apps whose config accepts a web (HTTP) MCP server with headers: Claude Code and VS Code (type "http"), Cursor (url + headers). */
export const HTTP_CAPABLE: readonly string[] = ["claude-code", "vscode", "cursor", "project"];

export type EntryKind = "monomem" | "legacy" | "other";

export function classifyEntry(name: string, entry: unknown): EntryKind {
  if (name === "monomem") return "monomem";
  const o = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const args = Array.isArray(o.args) ? o.args.map(String) : [];
  const line = [typeof o.command === "string" ? o.command : "", ...args].join(" ").toLowerCase().replace(/\\/g, "/");
  const envKeys = o.env && typeof o.env === "object" ? Object.keys(o.env as object) : [];
  const legacy = name === "claude-bridge" || /claude-bridge/.test(line) || envKeys.some((k) => k.startsWith("CLAUDE_BRIDGE_"));
  // The package's previous name: an `onememory` entry is renamed to `monomem` (data kept), not left beside a second one.
  if (legacy || name === "onememory" || /onememory/.test(line)) return "legacy";
  if (/monomem/.test(line)) return "monomem";
  return "other";
}

/** Where the old install keeps its data when the entry names no database: <install>/data/state.db. */
function dbBesideInstall(entry: Record<string, unknown>): string | null {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  for (const a of args) {
    const m = /^(.*)[\\/]dist[\\/]src[\\/][^\\/]+\.js$/.exec(a);
    if (m) {
      const sep = a.includes("\\") ? "\\" : "/";
      return `${m[1]}${sep}data${sep}state.db`;
    }
  }
  return null;
}

/** Turn an old claude-bridge entry into the Monomem entry that keeps its data. */
export function migrateEntry(e: SetupEnv, opts: Pick<SetupOptions, "command">, old: Record<string, unknown>, withType: boolean): { entry: ServerEntry; db: string | null; notes: string[] } {
  const notes: string[] = [];
  const env: Record<string, string> = {};
  const oldEnv = old.env && typeof old.env === "object" ? (old.env as Record<string, unknown>) : {};
  // A name already in the new style wins over its old-style twin, exactly as at run time (legacy-env.ts).
  for (const [k, v] of Object.entries(oldEnv)) if (typeof v === "string" && !k.startsWith("CLAUDE_BRIDGE_")) env[k] = v;
  for (const [k, v] of Object.entries(oldEnv)) {
    if (typeof v !== "string" || !k.startsWith("CLAUDE_BRIDGE_")) continue;
    const nk = "MONOMEM_" + k.slice("CLAUDE_BRIDGE_".length);
    if (!(nk in env)) env[nk] = v;
  }
  let db = env.MONOMEM_DB_PATH ?? null;
  if (!db) {
    const guess = dbBesideInstall(old);
    if (guess && existsSync(guess)) {
      env.MONOMEM_DB_PATH = guess;
      db = guess;
      notes.push(`the old entry named no database; found one at ${guess} and pointed the new entry at it`);
    } else {
      notes.push("the old entry named no database and none was found next to it: the new entry will start with the standard location (~/.monomem)");
    }
  }
  const entry = buildServerEntry(e, opts, env, withType);
  // Keep any extra setting the old entry had (a timeout, "disabled") rather than silently dropping it.
  for (const [k, v] of Object.entries(old)) if (!["command", "args", "env", "type"].includes(k)) entry[k] = v;
  return { entry, db, notes };
}

// ---- planning ----------------------------------------------------------------------------------------------------------

export interface FileChange {
  client: ClientId;
  label: string;
  file: string;
  /** Text as read when planned (null: the file does not exist yet). */
  before: string | null;
  ops: Op[];
  /** One line each, plain language. */
  lines: string[];
  /** Ops that put things back (recorded for --undo). */
  inverse: Op[];
  /** Allow replacing an existing 0-byte file (--force-empty). */
  allowEmpty?: boolean;
  /** Codex's config.toml: ops are TOML table edits (toml-table.ts), not JSON. */
  format?: "toml";
}

/** applyOps / opsAreApplied for either file format. */
const applyFor = (text: string, ops: readonly Op[], format?: "toml"): string => (format === "toml" ? applyTomlOps(text, ops) : applyOps(text, ops));
const appliedFor = (text: string, ops: readonly Op[], format?: "toml"): boolean => (format === "toml" ? tomlOpsApplied(text, ops) : opsAreApplied(text, ops));

export interface SetupPlan {
  nodeOk: boolean;
  found: ClientTarget[];
  changes: FileChange[];
  /** Databases to open (each distinct). */
  dbs: string[];
  warnings: string[];
  /** Entries that are already fine. */
  already: string[];
  conflicts: string[];
}

// Which Node can actually run Monomem. Two separate capabilities are needed,
// and they arrived at different times, so a single ">= x.y" rule is wrong:
//
//   1. `node:sqlite` importable with no flag -- notes are stored through it
//      (src/config.ts imports it at the top level, so a miss is a load-time crash)
//   2. SQLite built WITH FTS5 -- every search goes through an FTS5 table, so a
//      miss is `ERR_SQLITE_ERROR: no such module: fts5` on the first query
//
// Measured on official nodejs.org builds, not inferred from release notes:
//
//   22.5.0 - 22.12.x   node:sqlite behind --experimental-sqlite  -> refuse
//   22.13.0 - 22.15.x  node:sqlite unflagged, but NO FTS5        -> refuse
//   22.16.0+           both                                       -> ACCEPT
//   23.x (all of it)   no FTS5 even in 23.11.1, the last release -> refuse
//   24.0.0+            both                                       -> ACCEPT
//
// The whole Node 23 line is unusable, which is why this cannot be a simple
// "newer is fine" comparison: 23 is newer than 22.16 and still broken. 23 was
// never an LTS line and is end-of-life, so excluding it costs nothing.
//
// History of this gate getting it wrong: it demanded 24 (locking out all of
// LTS 22), then 2.1.1 said 22.5.0 (load-time crash on 22.5-22.12), then 22.13.0
// (FTS5 crash on 22.13-22.15, caught only once CI pinned the floor and ran it).
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 16;
const BROKEN_MAJOR = 23; // no FTS5 anywhere in the line
export const MIN_NODE_TEXT = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`;

/**
 * Ask this Node whether its SQLite actually has FTS5, instead of inferring it
 * from a version number.
 *
 * nodeIsOk() is a version heuristic built from the official nodejs.org builds,
 * and it is right for those. It cannot be right for a distro or custom build
 * that compiled SQLite with different flags at any version. Every Monomem
 * search goes through an FTS5 table, so "no such module: fts5" is fatal, and a
 * capability probe costs one in-memory statement.
 */
export function sqliteHasFts5(): boolean {
  try {
    // Loaded lazily through createRequire: this package is ESM, so a bare
    // `require` is not defined (that bug made the probe return false on a Node
    // that does have FTS5). Lazy, not a static import, so a Node without
    // node:sqlite reports false here instead of dying at module load.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function nodeIsOk(v: string): boolean {
  const m = /^v?(\d+)\.(\d+)\./.exec(v.trim());
  if (!m) return false; // unparseable: refuse rather than assume it is new enough
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === BROKEN_MAJOR) return false; // 23.x ships SQLite without FTS5
  if (major > MIN_NODE_MAJOR) return true;
  if (major < MIN_NODE_MAJOR) return false;
  return minor >= MIN_NODE_MINOR;
}

export function readTextFile(file: string): string | null {
  try {
    const buf = readFileSync(file);
    const text = buf.toString("utf8");
    if (Buffer.from(text, "utf8").compare(buf) !== 0) throw new JsonEditError(`${file} is not valid UTF-8 text; fix it first`);
    return text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function safeParseEntry(text: string, node: { start: number; end: number }): Record<string, unknown> | null {
  const slice = text.slice(node.start, node.end);
  let v: unknown;
  try {
    v = JSON.parse(slice);
  } catch {
    try {
      v = parseJsonc(slice); // comments or trailing commas inside the entry
    } catch {
      return null;
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

interface FoundServer {
  path: string[]; // path to the mcpServers object
  name: string;
  start: number;
  end: number;
}

function findServers(text: string, includeProjects: boolean, key = "mcpServers"): FoundServer[] {
  const doc = parseDoc(text);
  const res: FoundServer[] = [];
  const add = (path: string[]): void => {
    const node = getPath(doc, path);
    if (!node || node.kind !== "object") return;
    for (const m of node.members!) res.push({ path, name: m.key, start: m.value.start, end: m.value.end });
  };
  add([key]);
  if (includeProjects) {
    const projects = getPath(doc, ["projects"]);
    if (projects && projects.kind === "object") for (const p of projects.members!) add(["projects", p.key, "mcpServers"]);
  }
  return res;
}

/**
 * The object that holds the servers in each app's file. VS Code: "servers"; Zed: "context_servers"; Muse documents
 * "mcp_servers" (Meta's docs) but "mcpServers" is also seen and accepted as a legacy spelling, so an existing
 * "mcpServers" is kept rather than adding a second block.
 */
function serversKey(id: ClientId, text: string): string {
  if (id === "vscode") return "servers";
  if (id === "zed") return "context_servers";
  if (id === "muse") return text.trim() && !getPath(parseDoc(text), ["mcp_servers"]) && getPath(parseDoc(text), ["mcpServers"]) ? "mcpServers" : "mcp_servers";
  return "mcpServers";
}

/**
 * The app name setup writes as MONOMEM_CLIENT (written_by "stdio:<app>"): the client id, except a folder's .mcp.json,
 * which is Claude Code's project-scoped file. Self-declared by the config file, not a verified identity.
 */
const appLabel = (id: ClientId): string => (id === "project" ? "claude-code" : id);

/** Codex CLI: one [mcp_servers.monomem] table in ~/.codex/config.toml (command/args/env), everything else untouched. */
function planToml(e: SetupEnv, opts: SetupOptions, target: ClientTarget, text: string | null, shared: { dbs: Set<string>; dupOld?: number }): { change: FileChange | null; already: string[]; conflicts: string[]; warnings: string[] } {
  if (text !== null && hasServer(text, "monomem")) {
    const already = { change: null, already: [`${target.label}: "monomem" is already set up`], conflicts: [], warnings: [] };
    if (/MONOMEM_CLIENT/.test(text)) return already;
    // An entry from before per-app labels gets an [mcp_servers.monomem.env] table, but only when that cannot clash with
    // what is there: the entry is a table of its own and has no env yet (an inline `env = {...}` or an inline entry is
    // closed in TOML, so a second env would make the file invalid). Otherwise it keeps working, stamped plain "stdio".
    const table = findTable(text, ["mcp_servers", "monomem"]);
    if (!table || /^\s*"?env"?\s*[.=]/m.test(text.slice(table.start, table.end)) || findTable(text, ["mcp_servers", "monomem", "env"])) {
      return { ...already, warnings: [`${target.label}: to label its writes "stdio:codex", add MONOMEM_CLIENT = "codex" to the env of [mcp_servers.monomem] by hand`] };
    }
    const at = ["mcp_servers", "monomem"];
    return {
      change: { client: target.id, label: target.label, file: target.file, before: text, ops: [{ op: "set", path: at, key: "env", value: { MONOMEM_CLIENT: "codex" } }], lines: [`label "monomem" as codex (MONOMEM_CLIENT), so its writes are stamped "stdio:codex"`], inverse: [{ op: "remove", path: at, key: "env" }], allowEmpty: opts.forceEmpty, format: "toml" },
      already: [],
      conflicts: [],
      warnings: [],
    };
  }
  const entry = buildServerEntry(e, opts, { MONOMEM_CLIENT: target.id, ...(opts.db ? { MONOMEM_DB_PATH: opts.db } : {}), ...(opts.home ? { MONOMEM_HOME: opts.home } : {}) });
  if (opts.db) shared.dbs.add(opts.db);
  const ops: Op[] = [{ op: "set", path: ["mcp_servers"], key: "monomem", value: entry }];
  const lines = [`add the "monomem" memory server${opts.db ? ` (database ${opts.db})` : ""}`];
  return { change: { client: target.id, label: target.label, file: target.file, before: text, ops, lines, inverse: [{ op: "remove", path: ["mcp_servers"], key: "monomem" }], allowEmpty: opts.forceEmpty, format: "toml" }, already: [], conflicts: [], warnings: [] };
}

export function planFile(e: SetupEnv, opts: SetupOptions, target: ClientTarget, shared: { dbs: Set<string>; dupOld?: number }): { change: FileChange | null; already: string[]; conflicts: string[]; warnings: string[] } {
  const text = readTextFile(target.file);
  if (text === "" && !opts.forceEmpty) return { change: null, already: [], conflicts: [EMPTY_FILE_MSG(target.file)], warnings: [] };
  if (target.id === "codex") return planToml(e, opts, target, text, shared);
  const base = text ?? "";
  const key = serversKey(target.id, base);
  const already: string[] = [];
  const conflicts: string[] = [];
  const warnings: string[] = [];
  const lines: string[] = [];
  const ops: Op[] = [];
  const inverse: Op[] = [];
  const withType = target.id === "claude-code" || target.id === "project" || target.id === "vscode";
  const servers = base.trim() === "" ? [] : findServers(base, target.id === "claude-code", key);
  const top = servers.filter((s) => s.path.length === 1);
  const hasOneTop = top.some((s) => classifyEntry(s.name, safeParseEntry(base, s) ?? {}) === "monomem");
  let migrated = 0;
  let labelled = 0;
  let replaced = 0;
  for (const s of servers) {
    const entry = safeParseEntry(base, s);
    if (!entry) {
      warnings.push(
        /bridge/i.test(s.name)
          ? `${target.label}: the entry "${s.name}" looks like the old claude-bridge, but I could not read it, so I did NOT migrate it and left it alone. By hand: in the file, rename "${s.name}" to "monomem", set its "command" and "args" as shown in docs/live-claude-code.md, and rename its CLAUDE_BRIDGE_* settings to MONOMEM_* (same ending). Your data is not touched.`
          : `${target.label}: the entry "${s.name}" is in a form I do not understand; I left it alone`
      );
      continue;
    }
    const kind = classifyEntry(s.name, entry);
    const where = s.path.length === 1 ? "" : ` (project ${s.path[1]})`;
    if (kind === "monomem" && opts.httpEntry) {
      // Monomem's OWN entry (the one setup wrote, with no key) is replaced by the limited one. The change is shown, the file
      // is backed up like every other setup change, and `monomem setup --undo` puts the old entry back exactly.
      if (!HTTP_CAPABLE.includes(target.id)) {
        conflicts.push(`${target.label}: I cannot safely write a key-based connection into this app's config (its format is not verified). Use the paste-in block that  monomem connect ${target.id} --restricted --print  shows`);
        continue;
      }
      if ((entry as { url?: unknown }).url !== undefined || (entry as { headers?: unknown }).headers !== undefined) {
        conflicts.push(`${target.label}: "${s.name}"${where} already connects this app with its own key. To change its limit, take that connection out first: monomem token list  (then monomem token remove <name> and monomem setup --undo), and run connect again`);
        continue;
      }
      const limited = { ...(withType ? { type: "http" } : {}), url: opts.httpEntry.url, headers: opts.httpEntry.headers } as unknown as ServerEntry;
      ops.push({ op: "set", path: s.path, key: s.name, value: limited });
      inverse.unshift({ op: "set", path: s.path, key: s.name, value: entry });
      lines.push(`replace Monomem's own "${s.name}" entry${where}: it connected this app to ALL your notes with no key and no limit; the new entry uses its own key and limit`);
      replaced++;
      continue;
    }
    if (kind === "monomem") {
      const env = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? (entry.env as Record<string, unknown>) : null;
      // A folder's .mcp.json is only edited when asked (--project), the same as adding one.
      // Only a stdio entry (a command) is labelled: MONOMEM_CLIENT means nothing to an HTTP entry (url).
    if ((env && "MONOMEM_CLIENT" in env) || typeof entry.command !== "string" || (target.id === "project" && !opts.project)) {
        already.push(`${target.label}: "${s.name}"${where} is already set up`);
        continue;
      }
      // An entry from before per-app labels: name the app, so its writes are stamped stdio:<app> instead of plain stdio.
      const at = env ? [...s.path, s.name, "env"] : [...s.path, s.name];
      const op: Op = env ? { op: "set", path: at, key: "MONOMEM_CLIENT", value: appLabel(target.id) } : { op: "set", path: at, key: "env", value: { MONOMEM_CLIENT: appLabel(target.id) } };
      ops.push(op);
      inverse.unshift({ op: "remove", path: at, key: op.key });
      lines.push(`label "${s.name}"${where} as ${appLabel(target.id)} (MONOMEM_CLIENT), so its writes are stamped "stdio:${appLabel(target.id)}"`);
      labelled++;
      continue;
    }
    if (kind !== "legacy") continue;
    // An existing "monomem" next to the old one: do not merge two things by guesswork.
    const sibling = servers.some((x) => x.name === "monomem" && x.path.join("\u0000") === s.path.join("\u0000"));
    if (sibling && opts.removeOld) {
      ops.push({ op: "remove", path: s.path, key: s.name });
      inverse.unshift({ op: "set", path: s.path, key: s.name, value: entry });
      lines.push(`remove the old "${s.name}" entry${where}; the "monomem" entry beside it stays and your data is not touched`);
      continue;
    }
    if (sibling) {
      shared.dupOld = (shared.dupOld ?? 0) + 1;
      conflicts.push(`${target.label}: both "${s.name}" and "monomem" exist${where}; remove the one you do not want, then run setup again (run it at a terminal and it offers to remove the old one)`);
      continue;
    }
    const m = migrateEntry(e, opts, entry, withType);
    m.entry.env = { MONOMEM_CLIENT: appLabel(target.id), ...(m.entry.env ?? {}), ...(opts.db ? { MONOMEM_DB_PATH: opts.db } : {}), ...(opts.home ? { MONOMEM_HOME: opts.home } : {}) };
    ops.push({ op: "rename", path: s.path, key: s.name, newKey: "monomem", value: m.entry });
    inverse.unshift({ op: "rename", path: s.path, key: "monomem", newKey: s.name, value: entry });
    lines.push(`replace the old "${s.name}" entry${where} with "monomem"; ${m.db ? `your data stays where it is (${m.db})` : "standard data location"}. The old install folder is not touched`);
    lines.push(...m.notes.map((n) => "note: " + n));
    const dbToCheck = opts.db ?? m.db;
    if (dbToCheck) shared.dbs.add(dbToCheck);
    migrated++;
  }
  if (migrated === 0 && labelled === 0 && replaced === 0 && !hasOneTop && (target.id !== "project" || opts.project) && !already.length) {
    // MONOMEM_CLIENT names the app for written_by ("stdio:<app>"): a label the config declares, not a verified identity.
    const env: Record<string, string> = { MONOMEM_CLIENT: appLabel(target.id) };
    if (opts.db) env.MONOMEM_DB_PATH = opts.db;
    if (opts.home) env.MONOMEM_HOME = opts.home;
    let entry: ServerEntry;
    if (opts.httpEntry) {
      // Only apps whose web-connection format is documented are written here; the others get a paste-in snippet from `connect`.
      if (!HTTP_CAPABLE.includes(target.id)) {
        conflicts.push(`${target.label}: I cannot safely write a key-based connection into this app's config (its format is not verified). Use the paste-in block that  monomem connect ${target.id} --restricted --print  shows`);
        return { change: null, already, conflicts, warnings };
      }
      entry = { ...(withType ? { type: "http" } : {}), url: opts.httpEntry.url, headers: opts.httpEntry.headers } as unknown as ServerEntry;
    } else {
      entry = buildServerEntry(e, opts, env, withType);
    }
    // Muse: "optional" so a server that fails to start is skipped with a warning instead of aborting the whole run.
    if (target.id === "muse") entry = { transport: "stdio", ...entry, mode: "optional" };
    // Muse refuses to start without "schema_version": 1, so a file we create (or one missing it) gets it.
    if (target.id === "muse" && !(base.trim() && getPath(parseDoc(base), ["schema_version"]))) {
      ops.push({ op: "set", path: [], key: "schema_version", value: 1 });
      inverse.unshift({ op: "remove", path: [], key: "schema_version" });
    }
    ops.push({ op: "set", path: [key], key: "monomem", value: entry });
    inverse.unshift({ op: "remove", path: [key], key: "monomem" });
    lines.push(`add the "monomem" memory server${opts.db ? ` (database ${opts.db})` : ""}`);
    if (opts.db) shared.dbs.add(opts.db);
  }
  if (ops.length === 0) return { change: null, already, conflicts, warnings };
  return { change: { client: target.id, label: target.label, file: target.file, before: text, ops, lines, inverse, allowEmpty: opts.forceEmpty }, already, conflicts, warnings };
}

export const HOOK_MARKER = "recall --budget-ms";
/**
 * Our own start-of-session hook: the recall command we write, any command line
 * naming this tool with recall, or the capture session-start hook.
 *
 * `onememory` and `claude-bridge` are matched too, because this package has
 * been renamed twice and the hook line is written into the USER's settings
 * file, where it stays until setup rewrites it. Matching only the current name
 * would make setup fail to recognise its own hook on every existing install
 * and bolt a second, duplicate one in beside it.
 */
const TOOL_NAMES = "(?:monomem|onememory|claude-bridge)";
// Case-insensitive: these names are matched against an installed PATH, and a
// path's casing is the user's, not ours. A checkout at D:\a\Monomem\Monomem
// or ~/Projects/OneMemory is the same tool. Matching case-sensitively made
// setup miss its own hook and plan a duplicate -- found by CI, whose checkout
// directory is capitalised, on a machine where the local one is not.
const OLD_NPX_HOOK = /npx -y onememory-mcp@[^\s"]+ (?:recall|hook session-start)/;
const startRange = (doc: ReturnType<typeof parseDoc>, on: string): [number, number] => {
  const n = getPath(doc, ["hooks", on]);
  return n ? [n.start, n.end] : [0, 0];
};
const HOOK_DETECT = new RegExp(`recall --budget-ms|${TOOL_NAMES}[^\\n]{0,120}\\b(?:recall|hook session-start)\\b`, "i");

/**
 * Automatic memory: the Claude Code events the capture hooks run on, the `monomem hook <event>` each runs, and whether
 * it runs in the background (`async`: the agent does not wait for it). user-prompt is synchronous so the prompt is
 * recorded before the tools it causes; session-start (below) is synchronous because its output is the injected context.
 */
export const CAPTURE_HOOKS: ReadonlyArray<{ on: string; event: string; async: boolean; matcher?: string }> = [
  { on: "UserPromptSubmit", event: "user-prompt", async: false },
  // Advisory: what memory knows about a file, shown just before the agent reads it (never denies). Synchronous: its output is the context.
  { on: "PreToolUse", event: "file-context", async: false, matcher: "Read" },
  { on: "PostToolUse", event: "post-tool", async: true, matcher: "*" },
  { on: "PostToolUseFailure", event: "post-tool-failure", async: true, matcher: "*" },
  { on: "Stop", event: "stop", async: true },
  { on: "SubagentStop", event: "subagent-stop", async: true },
  { on: "SessionEnd", event: "session-end", async: true },
];

/** `monomem hook <event>` as a hook command (same launcher rules as buildHookCommand). */
export function buildCaptureCommand(e: SetupEnv, opts: Pick<SetupOptions, "command">, event: string, dbPath?: string): string {
  const useNpx = opts.command === "npx" || (opts.command === "auto" && runningFromNpxCache(e.cliPath));
  const db = dbPath ? ` --db "${dbPath.replace(/\\/g, "/")}"` : "";
  // A hook the agent waits for runs the global copy when there is one; the background ones stay on npx.
  const cli = useNpx && SYNC_HOOK_EVENTS.has(event) && opts.command === "auto" && e.globalCliPath ? e.globalCliPath : e.cliPath;
  if (useNpx && cli === e.cliPath) return `npx -y monomem@${e.version} hook ${event}${db}`;
  return `node "${cli.replace(/\\/g, "/")}" hook ${event}${db}`;
}

export function planHook(e: SetupEnv, opts: SetupOptions, dbForHook?: string): { change: FileChange | null; already: boolean; conflict?: string } {
  return planHooks(e, opts, dbForHook, { recall: true, capture: false });
}

type CaptureHook = { on: string; event: string; async: boolean; matcher?: string };

/** An agent with command hooks: where they live, its start-of-session event, and its events mapped to `monomem hook <event>`. */
export interface HookHost {
  client: ClientId;
  label: string;
  /** Who "does" things, in the plan's wording. */
  agent: string;
  file: string;
  start: { on: string; matcher?: string };
  events: ReadonlyArray<CaptureHook>;
  /** Extra plan lines (notes). */
  notes?: string[];
}

/**
 * Every agent whose hooks setup can wire. All take the Claude Code shape ({hooks: {<Event>: [{matcher?, hooks: [{type:
 * "command", command}]}]}}) and send session_id / cwd / prompt / tool_name / tool_input / tool_response on stdin
 * (capture.ts reads Gemini's AfterAgent `prompt_response` too).
 *  - Codex: ~/.codex/hooks.json; events and fields from developers.openai.com/codex/hooks (async is documented there).
 *  - Gemini CLI: the "hooks" key of ~/.gemini/settings.json; BeforeAgent/AfterTool/AfterAgent/SessionEnd per
 *    geminicli.com/docs/hooks. Lifecycle matchers must match exactly, so SessionStart gets none; no async field.
 *  - Muse: the "hooks" key of its settings.json. Meta lists the same event names as Claude Code but does not publish the
 *    stdin fields or the allowed group keys, and it skips a group with a key it does not know, so ours carry nothing but
 *    the command (no matcher, no async) and are recognised by their command line alone. UNVERIFIED: the stdin field names.
 */
/**
 * Claude Code's SessionStart sources: a new session, /clear, and after a /compact (the compacted context loses what the
 * session-start hook printed, so it is printed again). The matcher setup wrote before is upgraded in place on the next run.
 */
export const CLAUDE_START_MATCHER = "startup|clear|compact";
const OLD_CLAUDE_START_MATCHER = "startup|clear";

export function hookHosts(e: SetupEnv): HookHost[] {
  const muse = detectClients(e).find((t) => t.id === "muse")!.file;
  return [
    { client: "claude-code", label: "Claude Code hook", agent: "Claude", file: join(claudeDir(e), "settings.json"), start: { on: "SessionStart", matcher: CLAUDE_START_MATCHER }, events: CAPTURE_HOOKS },
    {
      client: "codex",
      label: "Codex CLI hook",
      agent: "Codex",
      file: join(codexDir(e), "hooks.json"),
      start: { on: "SessionStart", matcher: "startup|clear" },
      events: [
        { on: "UserPromptSubmit", event: "user-prompt", async: false },
        { on: "PostToolUse", event: "post-tool", async: true, matcher: "*" },
        { on: "Stop", event: "stop", async: true },
      ],
      notes: ["note: Codex runs a new hook only after you trust it: type /hooks in Codex and approve the Monomem ones"],
    },
    {
      client: "gemini",
      label: "Gemini CLI hook",
      agent: "Gemini",
      file: join(e.home, ".gemini", "settings.json"),
      start: { on: "SessionStart" },
      events: [
        { on: "BeforeAgent", event: "user-prompt", async: false },
        { on: "AfterTool", event: "post-tool", async: false, matcher: "*" },
        { on: "AfterAgent", event: "stop", async: false },
        { on: "SessionEnd", event: "session-end", async: false },
      ],
    },
    {
      client: "muse",
      label: "Muse hook",
      agent: "Muse",
      file: muse,
      start: { on: "SessionStart" },
      events: ["UserPromptSubmit:user-prompt", "PostToolUse:post-tool", "PostToolUseFailure:post-tool-failure", "Stop:stop", "SubagentStop:subagent-stop", "SessionEnd:session-end"].map((x) => {
        const [on, event] = x.split(":");
        return { on, event, async: false };
      }),
    },
  ];
}

/**
 * The hooks to add to ~/.claude/settings.json: the start-of-session context (`recall`, unless one of ours is already
 * there) and, with `capture`, one entry per CAPTURE_HOOKS event (each only if that event has no monomem hook yet).
 * With capture the start-of-session entry is `hook session-start`, which prints the same context and also does the
 * capture housekeeping. Existing entries, ours or anyone's, are never touched; every addition has its own undo op.
 */
export function planHooks(e: SetupEnv, opts: SetupOptions, dbForHook: string | undefined, want: { recall: boolean; capture: boolean }, host: HookHost = hookHosts(e)[0]): { change: FileChange | null; already: boolean; conflict?: string } {
  const file = host.file;
  const text = readTextFile(file);
  if (text === "" && !opts.forceEmpty) return { change: null, already: false, conflict: EMPTY_FILE_MSG(file) };
  const doc = text && text.trim() ? parseDoc(text) : null;
  const has = (on: string, re: RegExp): boolean => {
    const arr = doc ? getPath(doc, ["hooks", on]) : null;
    return !!arr && re.test(text!.slice(arr.start, arr.end));
  };
  const ops: Op[] = [];
  const inverse: Op[] = [];
  const lines: string[] = [];
  // The old package's start-of-session hook (`npx -y onememory-mcp@<v> recall|hook session-start`) is rewritten to the current command.
  const oldNpx = want.recall && doc ? OLD_NPX_HOOK.exec(text!.slice(...startRange(doc, host.start.on))) : null;
  const oldEntry = oldNpx ? getPath(doc!, ["hooks", host.start.on])?.items?.find((i) => text!.slice(i.start, i.end).includes(oldNpx[0])) : undefined;
  if (oldNpx && oldEntry) {
    let old: { hooks?: Array<{ command?: unknown }> } | null = null;
    try {
      old = JSON.parse(text!.slice(oldEntry.start, oldEntry.end));
    } catch {
      /* comments inside the entry: leave the old hook alone */
    }
    const command = want.capture ? buildCaptureCommand(e, opts, "session-start", dbForHook) : buildHookCommand(e, opts, dbForHook);
    const nu = old && Array.isArray(old.hooks) ? { ...old, hooks: old.hooks.map((x) => (typeof x?.command === "string" && x.command.includes(oldNpx[0]) ? { ...x, command } : x)) } : null;
    if (old && nu) {
      ops.push({ op: "unappend", path: ["hooks"], key: host.start.on, marker: oldNpx[0] }, { op: "append", path: ["hooks"], key: host.start.on, value: nu });
      inverse.unshift({ op: "append", path: ["hooks"], key: host.start.on, value: old });
      inverse.unshift({ op: "unappend", path: ["hooks"], key: host.start.on, marker: want.capture ? "hook session-start" : HOOK_MARKER });
      lines.push(`replace the start-of-session hook from the old onememory-mcp package with the current Monomem one (same place, same settings)`);
    }
  } else if (doc && host.start.matcher === CLAUDE_START_MATCHER && has(host.start.on, HOOK_DETECT)) {
    // Ours is already there: upgrade a "startup|clear" matcher setup wrote earlier, in place (no second entry).
    const items = getPath(doc, ["hooks", host.start.on])?.items ?? [];
    for (const marker of ["hook session-start", HOOK_MARKER]) {
      const first = items.find((i) => text!.slice(i.start, i.end).includes(marker));
      if (!first) continue;
      let old: { matcher?: unknown } | null = null;
      try {
        old = JSON.parse(text!.slice(first.start, first.end));
      } catch {
        /* comments inside the entry: leave it alone */
      }
      if (old && old.matcher === OLD_CLAUDE_START_MATCHER) {
        ops.push({ op: "unappend", path: ["hooks"], key: host.start.on, marker }, { op: "append", path: ["hooks"], key: host.start.on, value: { ...old, matcher: CLAUDE_START_MATCHER } });
        inverse.unshift({ op: "append", path: ["hooks"], key: host.start.on, value: old });
        inverse.unshift({ op: "unappend", path: ["hooks"], key: host.start.on, marker });
        lines.push(`also show your notes again after Claude Code compacts a conversation (start-of-session hook matcher "${OLD_CLAUDE_START_MATCHER}" becomes "${CLAUDE_START_MATCHER}")`);
      }
      break;
    }
  } else if (want.recall && !has(host.start.on, HOOK_DETECT)) {
    const command = want.capture ? buildCaptureCommand(e, opts, "session-start", dbForHook) : buildHookCommand(e, opts, dbForHook);
    const hooks = [{ type: "command", command }];
    ops.push({ op: "append", path: ["hooks"], key: host.start.on, value: host.start.matcher ? { matcher: host.start.matcher, hooks } : { hooks } });
    inverse.unshift({ op: "unappend", path: ["hooks"], key: host.start.on, marker: want.capture ? "hook session-start" : HOOK_MARKER });
    lines.push(`add a start-of-session hook that shows your recent notes to ${host.agent} (your existing hooks stay as they are)`);
  }
  if (want.capture) {
    let added = 0;
    for (const h of host.events) {
      // Ours: a command line naming this tool (the package or its cli.js path) with `hook <event>`; another tool's
      // hook is not. The retired names count: the command line lives in the USER's settings file and still holds
      // whatever path was installed then, so matching only the current name would add a duplicate hook on upgrade.
      if (has(h.on, new RegExp(`${TOOL_NAMES}[^\\n]{0,160}\\bhook ${h.event}(?![\\w-])`, "i"))) continue;
      const hook = { type: "command", command: buildCaptureCommand(e, opts, h.event, dbForHook), ...(h.async ? { async: true } : {}) };
      ops.push({ op: "append", path: ["hooks"], key: h.on, value: h.matcher ? { matcher: h.matcher, hooks: [hook] } : { hooks: [hook] } });
      inverse.unshift({ op: "unappend", path: ["hooks"], key: h.on, marker: `hook ${h.event}` });
      added++;
    }
    if (added) lines.push(`record what ${host.agent} does in every project (files, commands, errors) into Monomem, stored only on this machine (MONOMEM_CAPTURE=off turns it off)`);
  }
  if (!ops.length) return { change: null, already: true };
  if (host.notes) lines.push(...host.notes);
  return {
    change: { client: host.client, label: host.label, file, before: text, ops, lines, inverse, allowEmpty: opts.forceEmpty },
    already: false,
  };
}

// ---- diff (shown to the person) ------------------------------------------------------------------------------------------

const SECRET_LINE = /("[^"\n]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[^"\n]*"\s*:\s*)"[^"\n]*"/gi;
// Paths, ports and Monomem's own non-secret switches and labels print as they are; every other ALL_CAPS value is masked.
const PLAIN_ENV_KEY = /_(PATH|HOME|DIR|FILE|PORT|HOST|BIND|TIMEZONE)$|^MONOMEM_(CLIENT|TOOLS|CAPTURE|LINT|EMBEDDINGS|SPACES?|PROFILE)$/;
const ENV_STYLE_LINE = /("([A-Z][A-Z0-9_]{2,})"\s*:\s*)"[^"\n]*"/g;
// Command-line style secrets: an "args" array element after --token / --api-key / --key / --password / --secret (next element or --flag=value),
// and secret-named URL query parameters.
const ARG_NEXT = /("--?(?:token|api[-_]?key|key|password|passwd|secret|auth(?:orization)?|bearer)"\s*,\s*)"[^"\n]*"/gi;
const ARG_EQ = /("--?(?:token|api[-_]?key|key|password|passwd|secret|auth(?:orization)?|bearer)=)[^"\n]*"/gi;
const QUERY_SECRET = /([?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=)[^&\s"'#]+/gi;
const URL_CREDS = /(\b\w{1,20}:\/\/[^\s:@/"]{1,100}:)[^\s@/"]{1,200}@/g;

/** Hide values that could be secrets in a diff shown on screen: secret-looking keys, any ALL_CAPS env value that is not a plain path/port/etc., and user:pass@ in URLs. */
export function redact(s: string): string {
  return s
    .replace(SECRET_LINE, '$1"***"')
    .replace(ENV_STYLE_LINE, (m, pre: string, key: string) => (PLAIN_ENV_KEY.test(key) ? m : `${pre}"***"`))
    .replace(URL_CREDS, "$1***@")
    .replace(ARG_NEXT, '$1"***"')
    .replace(ARG_EQ, '$1***"')
    .replace(QUERY_SECRET, "$1***");
}

type DiffOp = readonly [" " | "-" | "+", string];
/** Longest-common-subsequence edit script; past the size cap the whole middle is one `-` block then one `+` block. */
function middleOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [...a.map((l): DiffOp => ["-", l]), ...b.map((l): DiffOp => ["+", l])]; // ponytail: cap, upgrade to Myers if configs ever get this big
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push([" ", a[i++]]), j++;
    else if (j < m && (i === n || t[i * w + j + 1] >= t[(i + 1) * w + j])) out.push(["+", b[j++]]);
    else out.push(["-", a[i++]]);
  }
  return out;
}

/** A small, exact line diff: only lines that really change get - or +; unchanged runs keep 2 lines of context and long ones are cut with "...". */
export function lineDiff(before: string, after: string, file: string): string[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: DiffOp[] = [
    ...a.slice(0, head).map((l): DiffOp => [" ", l]),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((l): DiffOp => [" ", l]),
  ];
  // An args array has the secret on the line AFTER "--token": mask whole files (line count unchanged), then look each line up.
  const masked = new Map<string, string>();
  for (const arr of [a, b]) {
    const m = redact(arr.join("\n")).split("\n");
    arr.forEach((l, i) => m[i] !== l && masked.set(l, m[i]));
  }
  const red = (l: string): string => masked.get(l) ?? redact(l);
  const ctx = 2;
  const first = ops.findIndex((o) => o[0] !== " ");
  const last = ops.length - 1 - [...ops].reverse().findIndex((o) => o[0] !== " ");
  const from = Math.max(0, first - ctx);
  const out = [`--- ${file}${before === "" ? " (new file)" : ""}`, `+++ ${file}`, `@@ line ${from + 1} @@`];
  for (let k = from; k <= Math.min(ops.length - 1, last + ctx); k++) {
    const [c, l] = ops[k];
    if (c === "-" && before === "") continue;
    if (c === " ") {
      let run = k;
      while (run < ops.length && run <= last && ops[run][0] === " ") run++;
      // An unchanged stretch between two changes: its first and last 2 lines, the rest elided.
      if (k > first && run <= last && run - k > 2 * ctx + 1) {
        for (let x = k; x < k + ctx; x++) out.push("  " + red(ops[x][1]));
        out.push("  ...");
        for (let x = run - ctx; x < run; x++) out.push("  " + red(ops[x][1]));
        k = run - 1;
        continue;
      }
    }
    out.push(`${c} ` + red(l));
  }
  return out;
}

// ---- writing: backup + atomic + re-read ----------------------------------------------------------------------------------

export interface WrittenChange {
  /** Which client this entry configured, so callers can group by vendor. */
  client: ClientId;
  file: string;
  /** Resolved real file (the target of a symlink). */
  real: string;
  backup: string | null;
  createdFile: boolean;
  afterSha: string;
  inverse: Op[];
  label: string;
  format?: "toml";
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from: string, to: string): void {
  // Windows can refuse a rename for a moment while antivirus or another program has the file open.
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // About 2 seconds elsewhere; about 7 on Windows, where antivirus and indexers hold files longer.
      const tries = process.platform === "win32" ? 12 : 8;
      if (i < tries && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        sleepSync(process.platform === "win32" ? Math.min(100 * (i + 1), 800) : 60 * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

function writeAtomic(real: string, text: string, mode: number | null): void {
  const tmp = join(dirname(real), `.${basename(real)}.monomem-tmp-${process.pid}-${randomBytes(3).toString("hex")}`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    try {
      fsyncSync(fd);
    } catch {
      /* some filesystems refuse; the rename is still atomic */
    }
  } finally {
    closeSync(fd);
  }
  try {
    if (mode !== null && process.platform !== "win32") chmodSync(tmp, mode);
    renameWithRetry(tmp, real);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* gone */
    }
    throw err;
  }
}

/**
 * Apply `change.ops` to the file as it is RIGHT NOW. If the file changes between our read and the rename (Claude Code
 * rewrites ~/.claude.json while it runs) the edit is re-applied to the newer text, up to 5 times. After the rename the
 * file is read back and the edit must still be there.
 */
export function writeChange(e: SetupEnv, change: FileChange): WrittenChange | null {
  const file = change.file;
  let real = file;
  try {
    real = realpathSync(file); // a symlinked config is edited at its target, so the link survives
  } catch {
    let isLink = false;
    try {
      isLink = lstatSync(file).isSymbolicLink();
    } catch {
      /* not there at all: fine, it will be created */
    }
    if (isLink) throw new JsonEditError(`${file} is a link to a file that does not exist; nothing was written (fix or remove the link, then run setup again)`);
    mkdirSync(dirname(file), { recursive: true });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    let buf: Buffer | null = null;
    try {
      buf = readFileSync(real);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (buf && buf.length === 0 && !change.allowEmpty) throw new JsonEditError(EMPTY_FILE_MSG(file));
    const current = buf ? buf.toString("utf8") : null;
    if (buf && current !== null && Buffer.from(current, "utf8").compare(buf) !== 0) throw new JsonEditError(`${file} is not valid UTF-8 text; nothing was written`);
    if (current !== null && appliedFor(current, change.ops, change.format)) return null; // already in place (someone else added it in the meantime)
    const next = applyFor(current ?? "", change.ops, change.format);
    let backup: string | null = null;
    if (buf) {
      backup = `${real}.monomem-backup-${stamp(e.now())}`;
      for (let n = 1; existsSync(backup); n++) backup = `${real}.monomem-backup-${stamp(e.now())}-${n}`;
      const bfd = openSync(backup, "wx", 0o600);
      try {
        writeSync(bfd, buf);
      } finally {
        closeSync(bfd);
      }
    }
    let mode: number | null = null;
    try {
      mode = statSync(real).mode & 0o777;
    } catch {
      /* new file */
    }
    // Last look before the swap: unchanged since we computed `next`?
    let again: Buffer | null = null;
    try {
      again = readFileSync(real);
    } catch {
      /* still absent */
    }
    if ((again === null) !== (buf === null) || (again && buf && again.compare(buf) !== 0)) {
      if (backup) unlinkSync(backup);
      sleepSync(40);
      continue; // changed under us: redo the edit on the newer text
    }
    writeAtomic(real, next, mode);
    // Read back: our edit must be there (a program holding an older copy could have written it over).
    const back = readFileSync(real, "utf8");
    const stillThere = appliedFor(back, change.ops, change.format);
    if (stillThere) return { client: change.client, file, real, backup, createdFile: buf === null, afterSha: sha(back), inverse: change.inverse, label: change.label, ...(change.format ? { format: change.format } : {}) };
    if (attempt === 4) throw new Error(`${file} keeps being rewritten by another program, so the change did not stay. Close the assistant that owns that file and run setup again.`);
    sleepSync(80);
  }
  throw new Error(`${file} changed while I was working on it; run setup again (close the assistant that owns it first).`);
}

// ---- undo history ----------------------------------------------------------------------------------------------------------

export interface HistorySession {
  id: string;
  at: string;
  version: string;
  undone?: boolean;
  changes: WrittenChange[];
  /** Databases setup opened, with the schema version each had BEFORE (null: none yet), so --undo can say what rolling back needs. */
  dbs?: Array<{ path: string; before: number | null }>;
  /** An old claude-bridge entry was replaced in this session. */
  migratedLegacy?: boolean;
}

/** The data folder: MONOMEM_HOME, else ~/.monomem. */
export function dataHome(e: SetupEnv): string {
  const home = e.env.MONOMEM_HOME?.trim();
  return home ? resolve(home) : join(e.home, ".monomem");
}

export function historyFile(e: SetupEnv): string {
  return join(dataHome(e), "setup-history.json");
}

export function readHistory(e: SetupEnv): HistorySession[] {
  try {
    const v = JSON.parse(readFileSync(historyFile(e), "utf8")) as unknown;
    return Array.isArray(v) ? (v as HistorySession[]) : [];
  } catch {
    return [];
  }
}

export function saveHistory(e: SetupEnv, all: HistorySession[]): void {
  const f = historyFile(e);
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeAtomic(f, JSON.stringify(all, null, 2) + "\n", 0o600);
}

/**
 * `--undo` puts the configuration back; it never touches a database. If the old claude-bridge entry came back after the
 * database was upgraded, that old program cannot open the upgraded file, so say exactly how to go back.
 */
async function reportDatabaseAfterUndo(s: HistorySession, io: SetupIO): Promise<void> {
  const { Store } = await import("./store.js");
  const upgraded: Array<{ path: string; before: number; now: number }> = [];
  for (const d of s.dbs ?? []) {
    const now = Store.peekSchemaVersion(d.path);
    if (d.before !== null && now !== null && now > d.before) upgraded.push({ path: d.path, before: d.before, now });
  }
  if (!s.migratedLegacy || upgraded.length === 0) {
    io.out("Your notes (the database) were not touched" + (s.migratedLegacy ? " and were not upgraded by setup." : "."));
    return;
  }
  io.out("\nIMPORTANT: your notes were NOT rolled back, only the configuration was.");
  for (const u of upgraded) {
    const bak = `${u.path}.pre-v${u.now}-backup`;
    io.out(`  ${u.path} was upgraded from schema v${u.before} to v${u.now}. The old claude-bridge program cannot open an upgraded database,`);
    io.out("  so the restored entry will fail until you do ONE of these:");
    io.out("   A. Keep the new database and use Monomem:  monomem setup   (it will reconnect you).");
    io.out(`   B. Go fully back (notes written since the upgrade are lost, so run \`monomem backup --out <folder>\` first if you want them):`);
    io.out("        1. Close every assistant and program that uses the database.");
    io.out(`        2. Move the safety copy over it:  ${bak}  ->  ${u.path}`);
    io.out(`        3. Delete  ${u.path}-wal  and  ${u.path}-shm  if they exist (they belong to the upgraded file).`);
    if (!existsSync(bak)) io.out(`      (I do not see ${bak}; if it was removed, option B is not possible.)`);
  }
}
export async function undoLast(e: SetupEnv, io: SetupIO): Promise<number> {
  const all = readHistory(e);
  const idx = [...all.keys()].reverse().find((i) => !all[i].undone);
  if (idx === undefined) {
    io.out("Nothing to undo: setup has not changed any file on this computer (or it was already undone).");
    return 0;
  }
  const s = all[idx];
  io.out(`Undoing the setup from ${s.at}:`);
  if (undoSession(e, io, s) === 0) {
    s.undone = true;
    saveHistory(e, all);
    io.out("Done. Restart any assistant that was open.");
    await reportDatabaseAfterUndo(s, io);
    return 0;
  }
  return 1;
}

/** Put back every file one setup session changed (newest change first). Returns how many could not be undone. */
export function undoSession(e: SetupEnv, io: SetupIO, s: HistorySession): number {
  let failed = 0;
  for (const c of [...s.changes].reverse()) {
    try {
      const current = existsSync(c.real) ? readFileSync(c.real, "utf8") : null;
      if (current === null) {
        io.out(`  ${c.file}: already gone, nothing to do`);
        continue;
      }
      if (sha(current) === c.afterSha) {
        // Untouched since we wrote it: put the exact original back.
        if (c.createdFile) {
          unlinkSync(c.real);
          io.out(`  ${c.file}: removed (setup had created it)`);
        } else if (c.backup && existsSync(c.backup)) {
          const orig = readFileSync(c.backup);
          writeAtomic(c.real, orig.toString("utf8"), statSync(c.real).mode & 0o777);
          io.out(`  ${c.file}: restored from ${c.backup}`);
        } else {
          io.err(`  ${c.file}: the backup ${c.backup} is missing; nothing was changed`);
          failed++;
        }
        continue;
      }
      // The program changed the file since (Claude Code does). Undo only OUR change; keep theirs.
      const reverted = applyFor(current, c.inverse, c.format);
      if (reverted === current) io.out(`  ${c.file}: our change is not there any more, nothing to do`);
      else {
        const backup = `${c.real}.monomem-backup-${stamp(e.now())}-before-undo`;
        copyFileSync(c.real, backup);
        writeAtomic(c.real, reverted, statSync(c.real).mode & 0o777);
        io.out(`  ${c.file}: it had changed since setup, so only the Monomem change was taken out (copy of the file as it was: ${backup})`);
      }
    } catch (err) {
      failed++;
      io.err(`  ${c.file}: could not undo (${(err as Error).message}). Your backup is ${c.backup ?? "(none; the file was new)"}`);
    }
  }
  return failed;
}

// ---- the command --------------------------------------------------------------------------------------------------------------

function describeSchema(v: number | null, current: number): string {
  if (v === null) return "no database there yet (or it cannot be read); a new one will be created when you go ahead";
  if (v === current) return `schema v${v}, up to date`;
  if (v < current) return `schema v${v}; this version upgrades it to v${current}, and first saves a safety copy next to it (<database>.pre-v${current}-backup). The upgrade is one-way: close Claude Code and anything else using this database first`;
  return `schema v${v} is NEWER than this version (v${current}); setup will not open it`;
}

export async function runSetup(e: SetupEnv, io: SetupIO, opts: SetupOptions): Promise<number> {
  if (!nodeIsOk(e.nodeVersion)) {
    io.err(
      `Monomem needs Node.js ${MIN_NODE_TEXT} or newer, and this computer has Node ${e.nodeVersion}.\n` +
        `  Fix: install Node 22.16+ or 24 LTS (https://nodejs.org), open a NEW terminal, check with:  node -v\n` +
        "  Then run this again. Nothing was changed. (Can't upgrade Node? Docker works too: see INSTALL.md.)"
    );
    return 1;
  }
  if (opts.undo) return undoLast(e, io);
  if (e.globalCliPath === undefined && opts.command === "auto" && runningFromNpxCache(e.cliPath)) e = { ...e, globalCliPath: detectGlobalCli(e) ?? null };

  // A database pinned in the shell (MONOMEM_DB_PATH, or the old CLAUDE_BRIDGE_DB_PATH) must also reach the app's entry,
  // because the app will not run inside this shell.
  const envDb = (e.env.MONOMEM_DB_PATH || e.env.CLAUDE_BRIDGE_DB_PATH || "").trim();
  if (!opts.db && envDb) opts = { ...opts, db: envDb };
  // The same for a data folder set with MONOMEM_HOME: without it in the entry, the app would use ~/.monomem instead.
  if (!opts.home && dataHome(e) !== resolve(join(e.home, ".monomem"))) opts = { ...opts, home: dataHome(e) };
  if (!opts.terse) {
    io.out(`Monomem setup (version ${e.version})`);
    io.out(`  Node ${e.nodeVersion}: OK\n`);
  }
  if (opts.home) io.out(`MONOMEM_HOME is set (${opts.home}), so each app entry setup writes gets MONOMEM_HOME too and uses that data folder.\n`);
  if (opts.only) {
    const bad = opts.only.filter((x) => !(CLIENT_IDS as readonly string[]).includes(x));
    if (bad.length) {
      io.err(`Unknown client: ${bad.join(", ")}. Choose from: ${CLIENT_IDS.join(", ")}.`);
      return 1;
    }
  }
  const found = detectClients(e);
  if (!opts.terse) {
    io.out("What I found:");
    for (const t of found) {
      if (t.id === "project" && !t.exists) continue;
      io.out(`  ${t.label.padEnd(26)} ${(t.exists ? "found" : t.present ? "installed, no config file yet" : "not found").padEnd(30)}${t.present ? t.file : ""}`.trimEnd());
    }
    io.out("");
  }

  let plan: SetupPlan = { nodeOk: true, found, changes: [], dbs: [], warnings: [], already: [], conflicts: [], };
  let shared: { dbs: Set<string>; dupOld?: number } = { dbs: new Set<string>() };
  const planApps = (): void => {
    plan = { nodeOk: true, found, changes: [], dbs: [], warnings: [], already: [], conflicts: [] };
    shared = { dbs: new Set<string>() };
    for (const t of found) {
      if (opts.only && !opts.only.includes(t.id)) continue;
      const asked = !!opts.only?.includes(t.id) || (t.id === "project" && opts.project);
      if (!t.present && !asked) continue; // an app that is not installed is left alone unless you name it
      const r = planFile(e, opts, t, shared);
      plan.already.push(...r.already);
      plan.conflicts.push(...r.conflicts);
      plan.warnings.push(...r.warnings);
      if (r.change) plan.changes.push(r.change);
    }
  };
  let offeredRemoval = false;
  try {
    planApps();
    // An old entry beside a "monomem" one: at a terminal (or a dry run) plan its removal so the diff shows it; it is applied only after a typed yes.
    if (shared.dupOld && !opts.yes && (io.interactive || opts.dryRun)) {
      opts = { ...opts, removeOld: true };
      planApps();
      offeredRemoval = true;
    }
  } catch (err) {
    io.err(`I could not read a configuration file safely, so I stopped before changing anything:\n  ${(err as Error).message}`);
    return 1;
  }
  const { Store, SCHEMA_VERSION } = await import("./store.js");
  const { DB_PATH } = await import("./config.js");
  const primaryDb = opts.db ?? [...shared.dbs][0] ?? DB_PATH;
  const dbs = shared.dbs.size ? [...shared.dbs] : [primaryDb];
  plan.dbs = dbs;
  for (const d of dbs) {
    const v = Store.peekSchemaVersion(d);
    if (v !== null && v > SCHEMA_VERSION) plan.conflicts.push(`database ${d} is at schema v${v}, which is newer than this version (v${SCHEMA_VERSION}); install the newest monomem`);
  }

  if (plan.changes.length === 0 && plan.conflicts.length === 0) {
    if (plan.already.length === 0) {
        io.out("I found no app to connect on this computer (none of the supported apps is installed), so nothing was changed. That is fine. What to do next:");
        io.out("  1. If you use one of these, name it and I will create its settings file:  monomem connect claude-code   (also: claude-desktop, cursor, codex, gemini, muse, vscode, zed)");
        io.out("  2. Or connect an app by hand: it needs the command  monomem mcp  (see INSTALL.md), or for a web connection run  monomem token add <app-name>  and paste what it prints.");
        io.out("  3. Not sure? Run  monomem doctor  to see what Monomem can find.");
      }
  }
  if (plan.conflicts.length) {
    io.err("Stopped, because:");
    for (const c of plan.conflicts) io.err("  - " + c);
    return 1;
  }

  // Hook decision: every installed agent with command hooks (Claude Code, Codex, Gemini CLI, Muse). One answer covers all.
  let wantHook = false;
  let wantCapture = false;
  const hookDb = primaryDbIfCustom(primaryDb, DB_PATH, opts);
  const hosts = hookHosts(e).filter((h) => !!found.find((t) => t.id === h.client)?.present && (!opts.only || opts.only.includes(h.client)));
  /** Per host: the start-of-session hook alone, and the automatic memory plan (which includes it). */
  const hookPlans = new Map<HookHost, FileChange>();
  const capturePlans = new Map<HookHost, FileChange>();
  const capture = opts.capture ?? "ask";
  for (const h of hosts) {
    const who = h.label.replace(/ hook$/, "");
    if (opts.hook !== "no") {
      const ph = planHooks(e, opts, hookDb, { recall: true, capture: false }, h);
      if (ph.conflict) plan.conflicts.push(ph.conflict);
      else if (ph.already) plan.already.push(`${who}: the start-of-session hook is already installed`);
      else if (ph.change) {
        if (opts.hook === "yes") wantHook = true;
        hookPlans.set(h, ph.change);
      }
    }
    // Automatic memory builds on the start-of-session hook: with --no-hook it is only added when asked for by name (--capture).
    if (capture !== "no" && !(capture === "ask" && opts.hook === "no")) {
      const pc = planHooks(e, opts, hookDb, { recall: opts.hook !== "no", capture: true }, h);
      if (pc.conflict) plan.conflicts.push(pc.conflict);
      else if (pc.already) plan.already.push(`${who}: the automatic memory hooks are already installed`);
      else if (pc.change && pc.change.lines.some((l) => l.startsWith("record what "))) {
        if (capture === "yes") wantCapture = true;
        capturePlans.set(h, pc.change);
      }
    }
  }
  const anyHook = hookPlans.size > 0;
  const hookReplacesOld = [...hookPlans.values()].some((c) => c.lines.some((l) => l.startsWith("replace the start-of-session hook")));
  const anyCapture = capturePlans.size > 0;

  if (plan.changes.length === 0 && !anyHook && !anyCapture) {
    for (const a of plan.already) io.out(`  (already fine) ${a}`);
    for (const w of plan.warnings) io.out(`  (careful) ${w}`);
    io.out(plan.already.length ? "\nNothing to change: Monomem is already connected. To check it, run:  monomem doctor" : "\nNothing was changed.");
    return 0;
  }

  io.out("What I will do:");
  let n = 1;
  for (const c of plan.changes) for (const l of c.lines) io.out(`  ${l.startsWith("note:") ? "   " : `${n++}. ${c.label}: `}${l}`);
  for (const d of dbs) io.out(`  ${n++}. Database ${d}: ${describeSchema(Store.peekSchemaVersion(d), SCHEMA_VERSION)}`);
  if (!opts.noTestNote) io.out(`  ${n++}. Write a test note, read it back and delete it, so you know writing, reading and deleting all work (your store is left empty)`);
  io.out(`  ${n++}. Run \`monomem doctor\` and tell you how to check the connection in your assistant`);
  for (const a of plan.already) io.out(`  (already fine) ${a}`);
  for (const w of plan.warnings) io.out(`  (careful) ${w}`);
  io.out("");
  io.out("Before any file is changed, a copy is saved beside it (name ends in .monomem-backup-<time>). `monomem setup --undo` puts it back.");
  io.out(`Please close ${closeList([...plan.changes.map((c) => c.client), ...hosts.map((h) => h.client)])} first, so it does not overwrite the change while it runs.`);
  if (anyCapture && syncHooksUseSlowNpx(e, opts)) io.out("\n" + NPX_LATENCY_NOTE(e.version));
  io.out("");

  // With automatic memory offered, its plan (which includes the start-of-session hook) is the one shown.
  const optional = hosts.flatMap((h) => capturePlans.get(h) ?? hookPlans.get(h) ?? []);
  const shown = [...plan.changes, ...optional];
  if (shown.length) {
    io.out("The exact change" + (shown.length > 1 ? "s" : "") + ":");
    for (const c of shown) {
      if (optional.includes(c)) io.out(`  Optional, only if you agree (${c.lines.join("; ")}):`);
      let after: string;
      try {
        after = applyFor(c.before ?? "", c.ops, c.format);
      } catch (err) {
        io.err(`I cannot make this edit safely (${(err as Error).message}). Nothing was changed.`);
        return 1;
      }
      for (const l of lineDiff(c.before ?? "", after, c.file)) io.out("  " + l);
      io.out("");
    }
  }

  if (opts.dryRun) {
    if (offeredRemoval) io.out("(The removal of the old entry above is only done if you say yes when you run setup for real.)");
    io.out("Dry run: nothing was changed. No file was written, and no database was created or upgraded.");
    if ((anyHook && !wantHook) || (anyCapture && !wantCapture)) io.out("(The hooks above are only added if you say yes to them, or pass --hook / --capture.)");
    return 0;
  }
  if (plan.changes.length === 0 && !anyHook && !anyCapture) return 0;

  if (!opts.yes) {
    if (!io.interactive) {
      io.err("This is not an interactive terminal, so I cannot ask. Re-run with --yes to go ahead (a backup is still made), or --dry-run to only look.");
      return 1;
    }
    const a = (await io.ask(plan.changes.length ? "Go ahead with the changes above? Type y to continue, anything else cancels: " : "Install the hooks? Type y: ")).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      io.out("Cancelled. Nothing was changed.");
      return 0;
    }
    if (offeredRemoval) {
      const r = (await io.ask("The old entry(ies) shown with - above sit beside your Monomem one. Remove them? Type y, or press Enter to cancel everything: ")).trim().toLowerCase();
      if (r !== "y" && r !== "yes") {
        io.out("Cancelled. Nothing was changed. Remove the old entry yourself, or run setup again and answer y.");
        return 0;
      }
    }
    if (anyHook && opts.hook === "ask") {
      const h = (await io.ask(`Also install the start-of-session hook (your assistant sees your recent notes when a session starts)${hookReplacesOld ? ". This REPLACES your old onememory-mcp hook with the current Monomem one" : ""}? Type y or n: `)).trim().toLowerCase();
      wantHook = h === "y" || h === "yes";
    }
    // Asked only after a yes to the start-of-session hook (or when it is already there): a no to that is a no to both.
    if (anyCapture && capture === "ask" && (wantHook || !anyHook)) {
      const c = (await io.ask("Also record what your assistant does in every project (files, commands, errors), stored only on this machine? Type y or n: ")).trim().toLowerCase();
      wantCapture = c === "y" || c === "yes";
    }
  } else {
    if (anyHook && opts.hook === "ask") wantHook = false; // --yes alone never adds a hook; it needs --hook
    if (anyCapture && capture === "ask") wantCapture = false; // ... or --capture
  }

  const dbsBefore = dbs.map((d) => ({ path: d, before: Store.peekSchemaVersion(d) }));
  const migratedLegacy = plan.changes.some((c) => c.inverse.some((o) => o.op === "rename"));
  // 1. The database first: if it cannot be opened, no config is touched.
  const storeErr: string[] = [];
  {
    for (const d of dbs) {
      try {
        const s = new Store(d);
        try {
          if (!opts.noTestNote) {
            // An install from before 2.1.0 still holds the note setup used to
            // leave behind. Clear it, or every existing user keeps the
            // installer's note about the installer for good and never gets the
            // cleaned-up behaviour -- the earlier fix only helped new stores.
            const old = s.list({ limit: 50, withTags: ["setup-check"] });
            let removed = 0;
            for (const n of old.notes) if (s.delete(n.id)) removed++;
            if (removed) io.out(`Database ${d}: removed ${removed} leftover test note${removed === 1 ? "" : "s"} from an earlier install — your store is yours now.`);
            {
              const note = s.create({
                title: "Monomem is connected",
                body: "This note was written by `monomem setup` to check that writing and reading work. You can delete it any time.",
                tags: ["setup-check"],
                source: "monomem setup",
              });
              const back = s.read(note.id); // gate-ok: setup reads back the test note it wrote a moment ago
              if (!back || back.title !== note.title || back.body !== note.body) throw new Error("the test note was written but did not read back the same");
              // Then remove it, so a brand-new store starts empty. Leaving it
              // behind made the installer's own note a permanent memory (1 of
              // the 13 notes in the maintainer's own store), and it was the
              // first thing a user ever searched for. Deleting it also proves
              // one more operation works than the old check did.
              if (!s.delete(note.id)) throw new Error("the test note was written and read back, but could not be deleted");
              io.out(`Database ${d}: test note written, read back and cleaned up.`);
            }
          } else io.out(`Database ${d}: opens fine.`);
        } finally {
          s.close();
        }
      } catch (err) {
        storeErr.push(`${d}: ${(err as Error).message}`);
      }
    }
  }
  if (storeErr.length) {
    io.err("The database could not be opened, so I changed NO configuration:");
    for (const m of storeErr) io.err("  " + m);
    return 1;
  }

  // 2. Configuration files.
  const written: WrittenChange[] = [];
  // Each hook file: automatic memory (with the start-of-session hook when that was wanted too), else the hook alone.
  const hookChanges = hosts.flatMap((h) => {
    const c = wantCapture ? planHooks(e, opts, hookDb, { recall: wantHook || (opts.hook !== "no" && !hookPlans.has(h)), capture: true }, h).change : wantHook ? hookPlans.get(h) : null;
    return c ? [c] : [];
  });
  const toWrite = [...plan.changes, ...hookChanges];
  try {
    for (const c of toWrite) {
      const w = writeChange(e, c);
      if (w) {
        written.push(w);
        io.out(`${c.label}: updated ${c.file}${w.backup ? `\n    backup: ${w.backup}` : " (new file)"}`);
      } else io.out(`${c.label}: ${c.file} already had it, unchanged`);
    }
  } catch (err) {
    io.err(`Stopped: ${(err as Error).message}`);
    if (written.length) {
      const all = readHistory(e);
      all.push({ id: stamp(e.now()), at: e.now().toISOString(), version: e.version, changes: written, dbs: dbsBefore, migratedLegacy });
      saveHistory(e, all);
      io.err("What was already written can be undone with: monomem setup --undo");
    }
    return 1;
  }
  if (written.length) {
    const all = readHistory(e);
    all.push({ id: stamp(e.now()), at: e.now().toISOString(), version: e.version, changes: written, dbs: dbsBefore, migratedLegacy });
    saveHistory(e, all);
  }

  // Remember a no to the Claude Code hook (or clear it after a yes), so `monomem health` reports "you chose no" as info, not a warning.
  const claudeHost = hosts.find((h) => h.client === "claude-code");
  if (claudeHost) {
    const marker = join(dirname(DB_PATH), HOOKS_DECLINED_FILE); // the standard data folder, never an old install's
    try {
      if (wantHook || wantCapture) rmSync(marker, { force: true });
      else if (hookPlans.has(claudeHost) || capturePlans.has(claudeHost)) {
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, "The Claude Code hook was declined when setup ran. Run monomem setup --hook to add it.\n");
      }
    } catch {
      /* best effort: only health's wording depends on it */
    }
  }

  // 3. Doctor.
  if (!opts.noDoctor) {
    io.out("\nmonomem doctor:");
    const env = { ...e.env };
    if (primaryDb !== DB_PATH) env.MONOMEM_DB_PATH = primaryDb;
    const r = spawnSync(e.execPath, [e.cliPath, "doctor"], { env, encoding: "utf8", timeout: 60_000 });
    for (const l of `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n")) if (l.trim()) io.out("  " + l);
  }

  // 4. Re-check after a moment: a running Claude Code may rewrite its file from an older copy in memory.
  sleepSync(1200);
  const missing: string[] = [];
  for (const w of written) {
    try {
      const cur = readFileSync(w.real, "utf8");
      if (!toWrite.filter((x) => x.file === w.file).every((c) => appliedFor(cur, c.ops, c.format))) missing.push(w.file);
    } catch {
      missing.push(w.file);
    }
  }
  if (missing.length) {
    io.err(`\nWarning: ${missing.join(", ")} was changed by another program just after I wrote it, and the Monomem entry is gone. Close the assistant that owns that file completely, then run setup again.`);
    return 1;
  }
  // The last thing setup says is the only thing most people will act on, so
  // spend it proving the ONE claim this product makes: a fact told to one
  // assistant is known by another. It used to end by asking the user to search
  // for the note the installer had just written about the installer -- proof
  // that Monomem could talk to itself, in the slot where attention peaks.
  if (opts.terse) {
    // `monomem connect` prints its own closing lines.
    io.out(`\nWritten. Restart ${written.length === 1 ? "that app" : "those apps"} so ${written.length === 1 ? "it picks" : "they pick"} up the change. To go back: monomem setup --undo`);
    return 0;
  }
  const proof = proofPair(written);
  io.out("\nDone. Restart any assistant that was open, so it picks up the new entry.");
  io.out("  Check it loaded: type  /mcp  (or your tool's equivalent) and look for  monomem  connected.");
  if (proof) {
    io.out(`\nOne memory, ${proof.sameVendor ? "two assistants" : "two companies' assistants"}. Thirty seconds to see it:`);
    io.out(`  1. In ${proof.a}, say:   Remember: my staging server is on port 8443.`);
    io.out(`  2. In ${proof.b}, ask:   What port is my staging server on?`);
    // Never assert what the other assistant WILL say: it searches memory only
    // if it decides to, and some hosts have no session-start hook at all. An
    // installer that over-promises in its last line is worse than one that
    // under-promises, so give the recovery instead of a guarantee.
    io.out(`\n  ${proof.b} was never told, and nothing left this machine. If it says it does not know,`);
    io.out("  ask it to search your memory — some assistants only look when you ask.");
    io.out("\n  Then ask either one:   Who wrote that note, and when?");
    io.out("  Every memory names the assistant that wrote it. That is the part other memory");
    io.out("  servers skip: when two agents disagree, you can see which one to believe.");
  } else {
    io.out("\nNow prove it (about 30 seconds):");
    io.out("  1. Say:   Remember: my staging server is on port 8443.");
    io.out("  2. Start a brand-new chat and ask:   What port is my staging server on?");
    io.out("\n  The new chat was never told. It answers 8443. Wire up a second assistant with `monomem setup` and the same memory follows you there.");
  }
  await offerClaudeMemPreview(e, io, opts, primaryDb);
  await offerServerMemoryPreview(e, io, opts, primaryDb);
  io.out("\nIf monomem is missing or red: docs/live-claude-code.md has the fixes. To go back: monomem setup --undo");
  return 0;
}

/** The clients whose config names the official `@modelcontextprotocol/server-memory` server (a plain-text look; nothing is parsed or changed). */
export function clientsUsingServerMemory(e: SetupEnv): string[] {
  const out: string[] = [];
  for (const t of detectClients(e)) {
    if (!t.exists || t.id === "project") continue;
    try {
      if (readFileSync(t.file, "utf8").includes("@modelcontextprotocol/server-memory")) out.push(t.label);
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

/** If an app already runs the official server-memory server, offer (default No) a DRY RUN import of its graph. */
async function offerServerMemoryPreview(e: SetupEnv, io: SetupIO, opts: SetupOptions, db: string): Promise<void> {
  const who = clientsUsingServerMemory(e);
  if (!who.length) return;
  const cmd = "monomem import --from mcp-memory --dry-run";
  if (!io.interactive || opts.yes) {
    io.out(`\nI found the server-memory server in ${who.join(", ")}. To preview bringing its notes over (nothing is written): ${cmd}`);
    return;
  }
  const a = (await io.ask(`\nI found the server-memory server in ${who.join(", ")}. Preview what importing its notes would do? Nothing leaves this computer and nothing is written. Type y, or press Enter to skip: `)).trim().toLowerCase();
  if (a !== "y" && a !== "yes") return;
  const { runForeignImport } = await import("./foreign-import.js");
  await runForeignImport(e, io, { from: "mcp-memory", dryRun: true, yes: false, dbPath: db });
}

/** If a claude-mem database is here, offer a DRY RUN import (never the real one). The importer opens it read-only, so nothing leaves this computer. */
async function offerClaudeMemPreview(e: SetupEnv, io: SetupIO, opts: SetupOptions, db: string): Promise<void> {
  const { defaultPath, runForeignImport } = await import("./foreign-import.js");
  const file = defaultPath("claude-mem", e);
  if (!existsSync(file)) return;
  if (!io.interactive || opts.yes) {
    io.out(`\nI found a claude-mem database (${file}). To preview bringing it over (nothing is written): monomem import --from claude-mem --dry-run`);
    return;
  }
  const a = (await io.ask(`\nI found a claude-mem database (${file}). Preview what importing it would do? Nothing leaves this computer and nothing is written. Type y, or press Enter to skip: `)).trim().toLowerCase();
  if (a !== "y" && a !== "yes") return;
  await runForeignImport(e, io, { from: "claude-mem", dryRun: true, yes: false, dbPath: db });
}

/**
 * Two configured clients to demonstrate cross-assistant recall with, preferring
 * two different vendors so the claim in the closing message is literally true.
 * Returns undefined when only one real client was wired (then there is no
 * cross-assistant claim to make, and setup must not pretend otherwise).
 */
export function proofPair(written: { client: string; label: string }[]): { a: string; b: string; sameVendor: boolean } | undefined {
  const vendorOf = (id: string): string =>
    id.startsWith("claude") ? "anthropic" : id === "codex" ? "openai" : id.startsWith("gemini") ? "google" : id;
  // `project` is a file in this folder, not an assistant someone can open.
  const seen = new Map<string, { client: string; label: string }>();
  for (const w of written) {
    if (w.client === "project") continue;
    if (!seen.has(w.client)) seen.set(w.client, w);
  }
  const clients = [...seen.values()];
  if (clients.length < 2) return undefined;
  for (const a of clients) {
    const b = clients.find((c) => vendorOf(c.client) !== vendorOf(a.client));
    if (b) return { a: a.label, b: b.label, sameVendor: false };
  }
  return { a: clients[0].label, b: clients[1].label, sameVendor: true };
}

function primaryDbIfCustom(primary: string, std: string, opts: SetupOptions): string | undefined {
  return opts.db || resolve(primary) !== resolve(std) ? primary : undefined;
}

/** Backups left by setup next to a config file (for tests and `doctor`). */
export function listBackups(file: string): string[] {
  const dir = dirname(file);
  const base = basename(file) + ".monomem-backup-";
  try {
    return readdirSync(dir).filter((f) => f.startsWith(base)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export { getMember };
