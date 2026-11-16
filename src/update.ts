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
// The npm install never self-modifies: it prints the npm command. The .old-* and .update-* leftovers go at the next update.
// Contract for future versions: `update --finish <old version>` must keep working (an older copy calls it on the newer one).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selfFacts, selfVersion, type SelfMode } from "./self.js";

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
    const [core, pre = ""] = v.replace(/^v/, "").split("-", 2);
    return [core.split(".").map((n) => Number(n) || 0), pre];
  };
  const [ac, ap] = parse(a);
  const [bc, bp] = parse(b);
  for (let i = 0; i < 3; i++) if ((ac[i] ?? 0) !== (bc[i] ?? 0)) return (ac[i] ?? 0) > (bc[i] ?? 0);
  if (ap === bp) return false;
  return ap === "" ? true : bp === "" ? false : ap > bp;
}

/** The rename the swap uses; injectable so a test can make one fail. */
export type RenameFn = (from: string, to: string) => void;

/**
 * Move every top-level entry of `staged` into `root`, putting the entry it replaces into `aside` first. A folder that
 * cannot be renamed as a whole (Windows: it holds a running node.exe) is moved file by file. On any failure every step
 * done so far is undone, in reverse, and the error is thrown: the install folder is as it was.
 */
export function swapIn(root: string, staged: string, aside: string, rename: RenameFn = renameSync): void {
  const undo: Array<() => void> = [];
  const moveAside = (src: string, dst: string): void => {
    try {
      rename(src, dst);
      undo.push(() => rename(dst, src));
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!statSync(src).isDirectory() || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw err;
    }
    mkdirSync(dst);
    undo.push(() => rmdirSync(dst));
    for (const c of readdirSync(src)) moveAside(join(src, c), join(dst, c));
    rmdirSync(src);
    undo.push(() => mkdirSync(src));
  };
  try {
    mkdirSync(aside, { recursive: true });
    for (const name of readdirSync(staged)) {
      const dst = join(root, name);
      if (existsSync(dst)) moveAside(dst, join(aside, name));
      rename(join(staged, name), dst);
      undo.push(() => rename(dst, join(staged, name)));
    }
  } catch (err) {
    for (const u of undo.reverse()) {
      try {
        u();
      } catch {
        /* keep undoing the rest */
      }
    }
    throw err;
  }
}

/** Remove what earlier updates left (.old-* still held by a running program then, .update-* downloads). Best effort. */
export function cleanupOld(root: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const n of names) if (/^\.(old|update)-/.test(n)) rmSync(join(root, n), { recursive: true, force: true, maxRetries: 2 });
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
  cleanupOld(d.root);

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
  if (!/^\d+\.\d+\.\d+/.test(latest)) {
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
  const name = assetName(latest, target);
  const archive = release.assets?.find((a) => a.name === name);
  const sumsAsset = release.assets?.find((a) => a.name === "SHA256SUMS");
  if (!archive || !sumsAsset) {
    d.err(`Release ${latest} has no ${archive ? "SHA256SUMS file" : name}, so I cannot update safely. Nothing was changed.`);
    return 1;
  }

  const staging = join(d.root, `.update-${latest}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const fail = (msg: string): number => {
    rmSync(staging, { recursive: true, force: true });
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
    rmSync(staging, { recursive: true, force: true });
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

  const aside = join(d.root, `.old-${d.version}`);
  rmSync(aside, { recursive: true, force: true });
  try {
    swapIn(d.root, fresh, aside, d.rename);
  } catch (e) {
    return fail(`Could not put the new version in place (${e instanceof Error ? e.message : String(e)}); every file was put back.`);
  }
  d.out(`Installed Monomem ${latest} in ${d.root} (the old ${d.version} is in ${aside} until the next update).`);
  rmSync(staging, { recursive: true, force: true, maxRetries: 2 });
  // The new code finishes: database migration and service restart.
  const fin = d.run(nodeIn(d.root, d.platform), [cliIn(d.root), "update", "--finish", d.version], true);
  if (fin.status !== 0) {
    d.err(`The new version is in place, but finishing the update failed (above). To go back: close your apps, then move the contents of ${aside} back into ${d.root}.`);
    return 1;
  }
  return 0;
}

/** `update --finish <old>`, run by the NEW copy right after the swap: migrate the database, restart the service. */
export async function finishUpdate(oldVersion: string, out: (l: string) => void, run: UpdateDeps["run"]): Promise<number> {
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
  if (run(c, a, false).status === 0) {
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

/** `monomem update [--check]` and the internal `update --finish <old version>`. */
export async function updateCmd(argv: string[]): Promise<number> {
  const i = argv.indexOf("--finish");
  if (i >= 0) {
    const d = realUpdateDeps();
    return finishUpdate(argv[i + 1] ?? "?", d.out, d.run);
  }
  const bad = argv.filter((a) => a !== "--check");
  if (bad.length) {
    console.error("Usage: monomem update [--check]   (--check only asks github.com whether a newer version is out)");
    return 1;
  }
  return runUpdate({ check: argv.includes("--check") }, realUpdateDeps());
}
