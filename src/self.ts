// "How do I launch myself": the one place that knows how this copy of Monomem was packaged. Every spawn of ourselves, every
// MCP entry, hook line and service written into another program's settings, the version and the package's own files go
// through here. Three packagings:
//   npm     node (on PATH or not) + <package>/dist/src/cli.js: npm i -g, npx, a source checkout. Today's behaviour.
//   bundle  the official signed node.exe shipped inside the Monomem folder, with the same dist/src/cli.js beside it. No Node
//           on PATH, so hooks name that node by its absolute path. Updates swap the folder's contents, so the path is the
//           stable launcher apps keep pointing at.
//   sea     a single executable (node:sea): the exe is the program, so nothing is passed before the subcommand.
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type SelfMode = "npm" | "bundle" | "sea";

/** What the launch decisions depend on. Injectable, so tests cover every mode without building a binary. */
export interface SelfFacts {
  mode: SelfMode;
  /** The running node (npm, bundle) or the executable itself (sea). */
  execPath: string;
  /** dist/src/cli.js (npm, bundle); the executable itself (sea). */
  cliPath: string;
  platform: NodeJS.Platform;
}

/** Set at build time for the bundled/SEA build (esbuild --define); absent in the npm build, which reads package.json. */
declare const __MONOMEM_VERSION__: string | undefined;

/** True inside a Node single executable application. */
export function isSea(): boolean {
  try {
    return (createRequire(import.meta.url)("node:sea") as { isSea(): boolean }).isSea();
  } catch {
    return false; // Node without node:sea
  }
}

/** This module's folder: dist/src in the npm and bundle layouts. In a one-file build every module shares the bundle's URL. */
const HERE = dirname(fileURLToPath(import.meta.url));
/** Built as separate files (dist/src/self.js), not merged into one bundle file. */
const UNBUNDLED = /[\\/]self\.js$/.test(fileURLToPath(import.meta.url));

/** The package root (where package.json, docs/ and bench/ sit): dist/src/../.. In the executable: its folder. */
function packageRoot(sea: boolean): string {
  return sea ? dirname(process.execPath) : join(HERE, "..", "..");
}

/** A node that lives inside the package folder is the bundled runtime (the folder download), not one the person installed. */
export function modeFor(sea: boolean, execPath: string, root: string): SelfMode {
  if (sea) return "sea";
  const rel = relative(root, execPath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? "bundle" : "npm";
}

/** The facts for this process. */
export function selfFacts(): SelfFacts {
  const sea = isSea();
  const mode = modeFor(sea, process.execPath, packageRoot(sea));
  // The CLI entry: cli.js beside this file. In a one-file build, the cli.js beside the bundle when there is one (the
  // standalone download's small entry that turns on the compile cache), else the bundle file itself.
  const cliPath = sea ? process.execPath : UNBUNDLED || existsSync(join(HERE, "cli.js")) ? join(HERE, "cli.js") : fileURLToPath(import.meta.url);
  return { mode, execPath: process.execPath, cliPath, platform: process.platform };
}

/** The path of the CLI entry to name in settings and checks (dist/src/cli.js; the executable in the sea build). */
export const SELF_CLI: string = selfFacts().cliPath;

/** The program and arguments that run `monomem <args>` from a spawn (no shell). */
export function selfCommand(args: string[], f: SelfFacts = selfFacts()): { command: string; args: string[] } {
  return f.mode === "sea" ? { command: f.execPath, args: [...args] } : { command: f.execPath, args: [f.cliPath, ...args] };
}

/** The launcher for `monomem service` (service.ts ServiceEnv): node + cli.js, or the executable alone. */
export function serviceLaunch(f: SelfFacts = selfFacts()): { node: string; cli?: string } {
  const c = selfCommand([], f);
  return c.args.length ? { node: c.command, cli: c.args[0] } : { node: c.command };
}

/**
 * One argument for a command line that a shell runs (hooks). Always double-quoted, backslashes turned into forward slashes
 * (both work in Windows paths, and a shell reads no escapes in them), so a plain path comes out as `"C:/a b/cli.js"`.
 * POSIX shells expand $ ` \ and " inside double quotes: those are escaped. Windows: a hook line may run in cmd.exe or in
 * Git Bash, so only " is escaped (\" works in both: no Windows path holds one). A % stays literal: cmd.exe expands %NAME%
 * only when NAME is a set variable, and cannot escape it inside quotes (service install refuses such a path for that reason).
 */
export function quoteShellArg(s: string, platform: NodeJS.Platform): string {
  const fwd = s.replace(/\\/g, "/");
  return platform === "win32" ? `"${fwd.replace(/"/g, '\\"')}"` : `"${fwd.replace(/["$`]/g, (c) => "\\" + c)}"`;
}

/**
 * `monomem <args>` as a shell command line (hook commands in app settings). `rawTail` is appended as written (already
 * quoted pieces such as ` --db "<path>"`).
 *   npm     node "<cli.js>" ...        bare node: the person's Node on PATH, as hooks have always been written
 *   bundle  "<bundled node>" "<cli.js>" ...   no Node on PATH, so the bundled runtime by its absolute path
 *   sea     "<exe>" ...
 */
export function selfShellLine(rawTail: string, f: SelfFacts = selfFacts()): string {
  const q = (s: string): string => quoteShellArg(s, f.platform);
  const head = f.mode === "sea" ? q(f.execPath) : f.mode === "bundle" ? `${q(f.execPath)} ${q(f.cliPath)}` : `node ${q(f.cliPath)}`;
  return rawTail ? `${head} ${rawTail}` : head;
}

/** The package root, for package.json, docs/ and bench/. Null in the sea build: it carries no files besides itself. */
export function assetsRoot(f: Pick<SelfFacts, "mode"> = selfFacts()): string | null {
  return f.mode === "sea" ? null : packageRoot(false);
}

/** The folder the package code treats as its own (the 1.0.x data folder, the runner's files): the package root, or the exe's folder. */
export const PROJECT_ROOT: string = packageRoot(isSea());

/** The release version: the build-time define in the bundled builds, else package.json; "0.0.0" when neither is there. */
export function selfVersion(root: string | null = assetsRoot()): string {
  if (typeof __MONOMEM_VERSION__ === "string" && __MONOMEM_VERSION__) return __MONOMEM_VERSION__;
  if (!root) return "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
