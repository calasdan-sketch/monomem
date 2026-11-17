// `monomem update`: the standalone download's only way to a newer version. Explicit only: nothing calls it in the background
// and no hook ever runs it (no network call unless a person types this command).
//   1. ask github.com for the latest release (--check stops here)
//   2. download this platform's archive and the release's SHA256SUMS into <install>/.update-<ver>, check the SHA-256
//   3. unpack, and run the new copy's --version (it must start and say the version it claims)
//   4. rename-aside swap: each top-level entry of the install folder moves to <install>/.old-<ver>, the new one moves in.
//      A running node.exe (an app's MCP server, the service) cannot be overwritten on Windows, but it can be renamed, so the
//      swap works while apps are open; any failure puts every moved entry back. The folder's path never changes, so app
//      settings and hooks (which name <install>/runtime/node and <install>/dist/src/cli.js) need no rewrite.
//   5. the NEW copy runs `update --finish <old version>`: it opens the database (the one-time migration, with its backup,
//      happens now and not in the first hook, which never migrates) and re-installs the background service if one is set up.
// The npm install never self-modifies: it prints the npm command. The .old-* and .update-* leftovers go at the next update
// (one still in use by an open app stays, and is tried again the time after).
// The dashboard's Update button runs `update --restart-server <its pid>` detached from its server, with the output in
// <data>/update.log: after the swap the new copy stops that server and starts the new version (restartServerAfterUpdate).
// Contract for future versions: `update --finish <old version>` must keep working (an older copy calls it on the newer one).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selfCommand, selfFacts, selfVersion, type SelfMode } from "./self.js";

export const RELEASE_REPO = "calasdan-sketch/monomem";
export const TARGETS = ["win-x64", "darwin-arm64", "darwin-x64", "linux-x64"] as const;

/** This computer's download target, or null when no download is built for it. */
export function targetOf(platform: NodeJS.Platform, arch: string): string | null {
  const t = `${platform === "win32" ? "win" : platform}-${arch}`;
  return (TARGETS as readonly string[]).includes(t) ? t : null;
}

/** The release archive name (scripts/build-bundle.mjs archiveName makes the same). */
export function assetName(version: string, target: string): string {
  return `monomem-${version}-${target}.${target.startsWith("win-") ? "zip" : "tar.gz"}`;
}

/** `sha256sum` output: "<64 hex>  <name>" per line (a "*" before the name marks binary mode). */
export function parseSums(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const r = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (r) m.set(r[2].trim(), r[1].toLowerCase());
  }
  return m;
}

/** a > b for x.y.z versions; a pre-release (1.6.0-rc.1) sorts before its release. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string): [number[], string] => {
    const s = v.replace(/^v/, "").replace(/\+.*$/, ""); // build metadata (+...) never counts
    const dash = s.indexOf("-");
    const [core, pre] = dash < 0 ? [s, ""] : [s.slice(0, dash), s.slice(dash + 1)]; // rc.1-x keeps its hyphen
    return [core.split(".").map((n) => Number(n) || 0), pre];
  };
  const [ac, ap] = parse(a);
  const [bc, bp] = parse(b);
  for (let i = 0; i < 3; i++) if ((ac[i] ?? 0) !== (bc[i] ?? 0)) return (ac[i] ?? 0) > (bc[i] ?? 0);
  if (ap === bp) return false;
  if (ap === "" || bp === "") return ap === "";
  // semver: dot parts left to right; numbers compare as numbers and sort before words; more parts win when all match.
  const as = ap.split("."), bs = bp.split(".");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] === bs[i]) continue;
    const an = /^\d+$/.test(as[i]), bn = /^\d+$/.test(bs[i]);
    if (an && bn) return Number(as[i]) > Number(bs[i]);
    return an !== bn ? bn : as[i] > bs[i];
  }
  return as.length > bs.length;
}

/** The rename the swap uses; injectable so a test can make one fail. */
export type RenameFn = (from: string, to: string) => void;

/**
 * Move every top-level entry of `staged` into `root`, putting the entry it replaces into `aside` first. A folder that
 * cannot be renamed as a whole (Windows: it holds a running node.exe) is moved file by file. On any failure every step
 * done so far is undone, in reverse, and the error is thrown: the install folder is as it was, unless an undo step failed
 * too; those are listed on the error as `undoFailed` ("<path>: <error>").
 */
export function swapIn(root: string, staged: string, aside: string, rename: RenameFn = renameSync): void {
  // Each undo step names what it puts back, so a step that fails can be reported.
  const undo: Array<[string, () => void]> = [];
  const moveAside = (src: string, dst: string): void => {
    try {
      rename(src, dst);
      undo.push([src, () => rename(dst, src)]);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!statSync(src).isDirectory() || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw err;
    }
    mkdirSync(dst);
    undo.push([dst, () => rmdirSync(dst)]);
    for (const c of readdirSync(src)) moveAside(join(src, c), join(dst, c));
    rmdirSync(src);
    undo.push([src, () => mkdirSync(src)]);
  };
  try {
    mkdirSync(aside, { recursive: true });
    for (const name of readdirSync(staged)) {
      const dst = join(root, name);
      if (existsSync(dst)) moveAside(dst, join(aside, name));
      rename(join(staged, name), dst);
      undo.push([join(staged, name), () => rename(dst, join(staged, name))]);
    }
  } catch (err) {
    const undoFailed: string[] = [];
    for (const [what, u] of undo.reverse()) {
      try {
        u();
      } catch (e) {
        undoFailed.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); // keep undoing the rest
      }
    }
    if (undoFailed.length) Object.assign(err as object, { undoFailed });
    throw err;
  }
}

/** The folder removal the update uses; injectable so a test can make one fail as a locked folder does on Windows. */
export type RemoveFn = (path: string) => void;
const removeDir: RemoveFn = (p) => rmSync(p, { recursive: true, force: true, maxRetries: 2 });

/** Remove a folder; false (never a throw) when it cannot go, e.g. an open app still runs a node.exe inside it. */
export function tryRemove(path: string, rm: RemoveFn = removeDir): boolean {
  try {
    rm(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove what earlier updates left (.old-* still held by a running program then, .update-* downloads). Best effort: a
 * folder still in use stays until a later update. Returns the names that could not be removed.
 */
export function cleanupOld(root: string, rm: RemoveFn = removeDir): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => /^\.(old|update)-/.test(n) && !tryRemove(join(root, n), rm));
}

/** Windows ships bsdtar (reads zip); a Git for Windows GNU tar earlier on PATH cannot. */
function tarBin(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return platform === "win32" ? join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
}

export interface UpdateDeps {
  mode: SelfMode;
  /** The install folder (the package root of this copy). */
  root: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  out(line: string): void;
  err(line: string): void;
  /** Unpack an archive into a folder. */
  unpack(archive: string, into: string): void;
  /** Run a program and wait; inherit = show its output to the person. */
  run(command: string, args: string[], inherit: boolean): { status: number | null; stdout: string };
  rename?: RenameFn;
  remove?: RemoveFn;
  /** The dashboard's server, when the dashboard started this update: the new copy stops it and starts the new version. */
  restartServer?: number;
}

const nodeIn = (root: string, platform: NodeJS.Platform): string => join(root, "runtime", platform === "win32" ? "node.exe" : "node");
const cliIn = (root: string): string => join(root, "dist", "src", "cli.js");

/** `monomem update [--check]`. Returns the exit code. */
export async function runUpdate(flags: { check: boolean }, d: UpdateDeps): Promise<number> {
  if (d.mode === "npm") {
    d.out(`This Monomem (${d.version}) was installed with npm, so npm updates it:\n  npm i -g monomem@latest\nThen run  monomem setup  again, so your apps' hooks use the new version.`);
    return 0;
  }
  if (d.mode === "sea") {
    d.out("This single-file Monomem cannot update itself yet. Download the newest release from https://github.com/" + RELEASE_REPO + "/releases");
    return 0;
  }
  const target = targetOf(d.platform, d.arch);
  if (!target) {
    d.err(`There is no Monomem download for ${d.platform}-${d.arch}. Nothing was changed.`);
    return 1;
  }
  const offline = (what: string, e: unknown): number => {
    d.err(`Could not reach github.com to ${what} (${e instanceof Error ? e.message : String(e)}). Nothing was changed. Check the internet connection and try again.`);
    return 1;
  };
  let release: { tag_name?: string; assets?: Array<{ name: string; browser_download_url: string }> };
  try {
    const r = await d.fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": `monomem/${d.version}` }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return offline("look for an update", new Error(`HTTP ${r.status}`));
    release = (await r.json()) as typeof release;
  } catch (e) {
    return offline("look for an update", e);
  }
  const latest = String(release.tag_name ?? "").replace(/^v/, "");
  // Whole tag anchored: `latest` becomes part of a folder name that is later removed (`.update-<v>`).
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(latest)) {
    d.err("The latest release on github.com has no version number I understand. Nothing was changed.");
    return 1;
  }
  if (!isNewer(latest, d.version)) {
    d.out(`Monomem ${d.version} is the newest version. Nothing to do.`);
    return 0;
  }
  if (flags.check) {
    d.out(`Monomem ${latest} is out (you have ${d.version}). Get it:  monomem update`);
    return 0;
  }
  // Only now: --check never deletes the old copy a failed update tells the person to restore from.
  const stuck = cleanupOld(d.root, d.remove);
  if (stuck.length) d.out(`  (An old copy is still in use by an open app, so it stays until the next update: ${stuck.join(", ")}.)`);
  const name = assetName(latest, target);
  const archive = release.assets?.find((a) => a.name === name);
  const sumsAsset = release.assets?.find((a) => a.name === "SHA256SUMS");
  if (!archive || !sumsAsset) {
    d.err(`Release ${latest} has no ${archive ? "SHA256SUMS file" : name}, so I cannot update safely. Nothing was changed.`);
    return 1;
  }

  // A download folder still locked from an earlier try gets a fresh name instead of stopping the update.
  let staging = join(d.root, `.update-${latest}`);
  if (!tryRemove(staging, d.remove)) staging += `-${Date.now()}`;
  mkdirSync(staging, { recursive: true });
  const fail = (msg: string): number => {
    tryRemove(staging, d.remove);
    d.err(msg + " Nothing was changed.");
    return 1;
  };
  d.out(`Downloading Monomem ${latest} (${name})...`);
  const file = join(staging, name);
  let sums: Map<string, string>;
  try {
    const get = async (url: string): Promise<Buffer> => {
      const r = await d.fetch(url, { headers: { "user-agent": `monomem/${d.version}` }, signal: AbortSignal.timeout(300_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return Buffer.from(await r.arrayBuffer());
    };
    sums = parseSums((await get(sumsAsset.browser_download_url)).toString("utf8"));
    writeFileSync(file, await get(archive.browser_download_url));
  } catch (e) {
    tryRemove(staging, d.remove);
    return offline("download the update", e);
  }
  const want = sums.get(name);
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (!want) return fail(`SHA256SUMS of release ${latest} does not list ${name}.`);
  if (got !== want) return fail(`The download does not match its checksum (SHA-256 ${got}, release says ${want}). It was deleted.`);
  d.out(`  SHA-256 checked: ${got}`);
  d.out("  (The checksum file comes from the same release; to check the file was built by this project's CI, see INSTALL.md: gh attestation verify.)");

  const unpacked = join(staging, "unpacked");
  try {
    mkdirSync(unpacked);
    d.unpack(file, unpacked);
  } catch (e) {
    return fail(`Could not unpack ${name} (${e instanceof Error ? e.message : String(e)}).`);
  }
  const fresh = join(unpacked, "Monomem");
  if (!existsSync(nodeIn(fresh, d.platform)) || !existsSync(cliIn(fresh))) return fail(`${name} does not hold a Monomem folder (runtime and dist/src/cli.js).`);
  const said = d.run(nodeIn(fresh, d.platform), [cliIn(fresh), "--version"], false);
  if (said.status !== 0 || said.stdout.trim() !== latest) return fail(`The new copy did not start properly (it said "${said.stdout.trim()}", expected ${latest}).`);

  let aside = join(d.root, `.old-${d.version}`);
  if (!tryRemove(aside, d.remove)) aside += `-${Date.now()}`;
  try {
    swapIn(d.root, fresh, aside, d.rename);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const undoFailed = (e as { undoFailed?: string[] }).undoFailed ?? [];
    if (!undoFailed.length) return fail(`Could not put the new version in place (${why}); every file was put back.`);
    // Not "nothing was changed": say which entries are not back, and keep the download and the aside copy for them.
    d.err(`Could not put the new version in place (${why}), and ${undoFailed.length} item(s) could not be put back:`);
    for (const u of undoFailed) d.err(`  ${u}`);
    d.err(`Close your apps, then move them back from ${aside} and ${staging} into ${d.root}.`);
    return 1;
  }
  d.out(`Installed Monomem ${latest} in ${d.root} (the old ${d.version} is in ${aside} until the next update).`);
  tryRemove(staging, d.remove);
  // The new code finishes: database migration and service restart (and, from the dashboard, its server's restart).
  const restart = d.restartServer ? ["--restart-server", String(d.restartServer)] : [];
  const fin = d.run(nodeIn(d.root, d.platform), [cliIn(d.root), "update", "--finish", d.version, ...restart], true);
  if (fin.status !== 0) {
    d.err(`The new version is in place, but finishing the update failed (above). To go back: close your apps, then move the contents of ${aside} back into ${d.root}.`);
    return 1;
  }
  return 0;
}

/** What restarting the dashboard's server needs; injected so tests never stop or start a real process. */
export interface RestartDeps {
  /** Stop a process (POSIX: SIGTERM, the server's own clean shutdown; Windows: it ends at once, SQLite keeps what was saved). */
  kill(pid: number): void;
  alive(pid: number): boolean;
  /** Start `monomem start --log` of this (new) copy in the background, the way `monomem open` does. */
  startServer(): void;
  /** True once the new server answers /health. */
  waitUp(): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

/**
 * The dashboard's Update button: after the swap, stop the server that ran the button (it still runs the old code) and run
 * the new one. With the background service set up, the service brings it back (finishUpdate re-installs it); otherwise
 * (started by `monomem open` or the Start menu) this starts it. Returns false when the server did not come back.
 */
export async function restartServerAfterUpdate(pid: number, service: boolean, r: RestartDeps, out: (l: string) => void): Promise<boolean> {
  out("Stopping the Monomem server that still runs the old version...");
  try {
    r.kill(pid);
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 50 && r.alive(pid); i++) await r.sleep(200);
  if (r.alive(pid)) {
    out(`  The old server (process ${pid}) did not stop. Close it, then start Monomem again (monomem open).`);
    return false;
  }
  if (service) return true;
  r.startServer();
  if (await r.waitUp()) {
    out("Monomem is running the new version.");
    return true;
  }
  out("  The new version did not start. Start it with:  monomem open");
  return false;
}

function realRestartDeps(): RestartDeps {
  return {
    kill: (pid) => process.kill(pid),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    startServer: () => {
      const s = selfCommand(["start", "--log"]);
      spawn(s.command, s.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    },
    waitUp: async () => {
      const { API_PORT } = await import("./config.js");
      for (let i = 0; i < 40; i++) {
        try {
          if ((await fetch(`http://127.0.0.1:${API_PORT}/health`, { signal: AbortSignal.timeout(1000) })).ok) return true;
        } catch {
          /* not up yet */
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      return false;
    },
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  };
}

/** `update --finish <old>`, run by the NEW copy right after the swap: migrate the database, restart the service. */
export async function finishUpdate(oldVersion: string, out: (l: string) => void, run: UpdateDeps["run"], serverPid?: number, restart: RestartDeps = realRestartDeps()): Promise<number> {
  const { DB_PATH } = await import("./config.js");
  if (existsSync(DB_PATH)) {
    const { Store, SCHEMA_VERSION } = await import("./store.js");
    const before = Store.peekSchemaVersion(DB_PATH);
    new Store(DB_PATH).close(); // opening migrates (with the one-time backup beside the file)
    out(before !== null && before < SCHEMA_VERSION ? `Database ${DB_PATH}: upgraded from schema v${before} to v${SCHEMA_VERSION} (a copy of the old file is beside it).` : `Database ${DB_PATH}: up to date (schema v${SCHEMA_VERSION}).`);
  } else out("No database yet: nothing to upgrade.");
  const f = selfFacts();
  const self = (args: string[]): [string, string[]] => (f.mode === "sea" ? [f.execPath, args] : [f.execPath, [f.cliPath, ...args]]);
  const [c, a] = self(["service", "status"]);
  const service = run(c, a, false).status === 0;
  // From the dashboard: its server stops first, so a service restart below never ends the process running this update.
  if (serverPid) await restartServerAfterUpdate(serverPid, service, restart, out); // it prints what to do if it fails
  if (service) {
    out("Restarting the background service with the new version:");
    const [c2, a2] = self(["service", "install"]);
    if (run(c2, a2, true).status !== 0) out("  The service did not restart (above). Start it again with:  monomem service install");
  }
  out(`Updated from ${oldVersion} to ${selfVersion()}. Restart Claude Code, Cursor and any other app that was open, so they use the new version.`);
  return 0;
}

/** The real dependencies for the CLI. */
export function realUpdateDeps(): UpdateDeps {
  const f = selfFacts();
  const root = join(f.cliPath, "..", "..", "..");
  return {
    mode: f.mode,
    root,
    version: selfVersion(),
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    fetch,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    unpack: (archive, into) => execFileSync(tarBin(process.platform, process.env), ["-xf", archive, "-C", into], { stdio: "ignore", windowsHide: true }),
    run: (command, args, inherit) => {
      const r = spawnSync(command, args, { encoding: "utf8", stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"], windowsHide: true });
      return { status: r.status, stdout: r.stdout ?? "" };
    },
  };
}

/** The pid after `--restart-server`, or undefined. */
function pidArg(argv: string[]): number | undefined {
  const i = argv.indexOf("--restart-server");
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The last line of an update the dashboard started (its page reads update.log for it). */
export const UPDATE_END = (code: number): string => `(update ended with exit code ${code})`;

/** `monomem update [--check]`, the internal `update --finish <old version> [--restart-server <pid>]`, and the dashboard's
 *  `update --restart-server <pid>`. */
export async function updateCmd(argv: string[]): Promise<number> {
  const i = argv.indexOf("--finish");
  if (i >= 0) {
    const d = realUpdateDeps();
    return finishUpdate(argv[i + 1] ?? "?", d.out, d.run, pidArg(argv));
  }
  const pid = pidArg(argv);
  const bad = argv.filter((a, j) => a !== "--check" && !(pid && (a === "--restart-server" || argv[j - 1] === "--restart-server")));
  if (bad.length) {
    console.error("Usage: monomem update [--check]   (--check only asks github.com whether a newer version is out)");
    return 1;
  }
  const code = await runUpdate({ check: argv.includes("--check") }, { ...realUpdateDeps(), restartServer: pid });
  if (pid) console.log(UPDATE_END(code));
  return code;
}
