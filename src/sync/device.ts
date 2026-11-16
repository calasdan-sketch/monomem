// Device sync made easy: `monomem sync setup <private git address | shared folder>` once, then `monomem sync` (or the
// server's timer, off by default) keeps this computer in step with your others.
//
// - A git address: cloned once into <data dir>/sync-repo, then the usual `sync --git` (always sealed).
// - A folder (OneDrive, Dropbox, iCloud Drive, a USB disk, a network share): sealed note files go into <folder>/monomem-enc,
//   and the folder's own sync tool carries them. No git needed.
// Both ways every note file is sealed (AES-256-GCM) with a sync key that lives only in the data folder and is never written
// into the repository or the shared folder. Hard deletes never travel (they arrive as an archive); conflicts keep both texts.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addressHasSecret, isInside, mergeVault, readKey, realPath, runGitSync, scrubUrls, SyncStop, VAULT_ENC, type GitSyncIO } from "../sync-git.js";

export interface SyncConfig {
  kind: "git" | "folder";
  /** The git address or the folder, as given. */
  target: string;
  /** git: the local clone. */
  repo?: string;
  keyFile: string;
  /** Run from the server's timer (off by default). */
  auto: boolean;
  everyMinutes: number;
}

const CONFIG = "sync.json";
export const DEFAULT_EVERY_MINUTES = 30;
const MIN_EVERY_MINUTES = 5;

export function readSyncConfig(dataDir: string): SyncConfig | null {
  try {
    const c = JSON.parse(readFileSync(join(dataDir, CONFIG), "utf8")) as Partial<SyncConfig>;
    if ((c.kind !== "git" && c.kind !== "folder") || typeof c.target !== "string" || typeof c.keyFile !== "string") return null;
    const every = Number(c.everyMinutes);
    return {
      kind: c.kind,
      target: c.target,
      ...(typeof c.repo === "string" ? { repo: c.repo } : {}),
      keyFile: c.keyFile,
      auto: c.auto === true,
      everyMinutes: Number.isFinite(every) && every >= MIN_EVERY_MINUTES ? Math.floor(every) : DEFAULT_EVERY_MINUTES,
    };
  } catch {
    return null;
  }
}

function writeSyncConfig(dataDir: string, c: SyncConfig): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const p = join(dataDir, CONFIG);
  writeFileSync(`${p}.tmp`, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}

/** `https://...`, `ssh://...`, `git@host:path`: a git address. A Windows drive path (`C:\...`) is a folder. */
export function looksLikeRemote(t: string): boolean {
  return /^[a-z][a-z0-9+.-]{1,20}:\/\//i.test(t) || /^[^\s/\\@]+@[^\s/\\:]+:/.test(t);
}

export interface DeviceEnv {
  dataDir: string;
  dbPath: string;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** One sync through a shared folder (no git): unseal, merge, write back sealed. */
export async function runFolderSync(io: GitSyncIO, o: DeviceEnv & { folder: string; keyFile: string }): Promise<number> {
  const now = o.now ?? (() => new Date());
  try {
    const folder = resolve(o.folder);
    if (!existsSync(folder)) throw new SyncStop(`The sync folder ${folder} is not there (is the drive or cloud folder connected?). Nothing was changed.`);
    const vault = join(folder, VAULT_ENC);
    let st = null;
    try {
      st = lstatSync(vault);
    } catch {
      /* first run */
    }
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new SyncStop(`${VAULT_ENC} in the sync folder is a link or not a folder; I will not follow it. Nothing was changed.`);
    if (isInside(folder, o.keyFile)) throw new SyncStop(`The key file ${o.keyFile} is inside the sync folder. A key must never travel with the notes; move it.`);
    if (isInside(folder, o.dataDir)) throw new SyncStop(`The data folder is inside the sync folder: the sync tool would copy the live database and keys. Pick another folder.`);
    io.out(`Folder sync of ${o.dbPath}`);
    io.out(`  folder : ${folder}  (sealed: names and text are encrypted; key stays in ${o.keyFile})`);
    await mergeVault(io, { vault, encrypt: true, key: readKey(o.keyFile), keyFile: o.keyFile, dataDir: o.dataDir, dbPath: o.dbPath, seenFor: realPath(folder), now, where: "folder" });
    io.out("  done. Your folder's sync tool carries the files to your other computers.");
    return 0;
  } catch (e) {
    io.err("Stopped: " + scrubUrls((e as Error).message));
    return 1;
  }
}

/** `monomem sync` with no address: the one `sync setup` saved. Writes sync-status.json (time, ok) for the dashboard / doctor. */
export async function runConfiguredSync(io: GitSyncIO, o: DeviceEnv): Promise<number> {
  const c = readSyncConfig(o.dataDir);
  if (!c) {
    io.err("No sync is set up. Run: monomem sync setup <your private git address, or a shared folder such as OneDrive>");
    return 1;
  }
  const code =
    c.kind === "git"
      ? await runGitSync(io, { repo: c.repo!, encrypt: true, keyFile: c.keyFile, dryRun: false, noPush: false, yes: true, dataDir: o.dataDir, dbPath: o.dbPath, env: o.env, now: o.now })
      : await runFolderSync(io, { ...o, folder: c.target, keyFile: c.keyFile });
  try {
    writeFileSync(join(o.dataDir, "sync-status.json"), JSON.stringify({ at: (o.now ?? (() => new Date()))().toISOString(), ok: code === 0 }) + "\n", { mode: 0o600 });
  } catch {
    /* status is a convenience */
  }
  return code;
}

export interface SetupOptions extends DeviceEnv {
  target?: string;
  auto?: boolean;
  everyMinutes?: number;
  name?: string;
}

/** `monomem sync setup <target> [--auto on|off] [--every N] [--name label]`: save the choice, then sync once. */
export async function setupSync(io: GitSyncIO, o: SetupOptions): Promise<number> {
  const old = readSyncConfig(o.dataDir);
  try {
    if (o.name !== undefined) {
      const { Store } = await import("../store.js");
      const { setMachineLabel } = await import("./marks.js");
      mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
      const s = new Store(o.dbPath);
      try {
        io.out(`This computer is now called "${setMachineLabel(s, o.name)}" on your other computers (after the next sync).`);
      } finally {
        s.close();
      }
    }
    const target = o.target?.trim() || old?.target;
    if (!target) throw new SyncStop("Say where to sync: monomem sync setup <your private git address, or a shared folder such as OneDrive>");
    const keyFile = old?.keyFile ?? join(o.dataDir, ".sync-key");
    let c: SyncConfig;
    if (looksLikeRemote(target)) {
      if (addressHasSecret(target)) throw new SyncStop("That address has a password or token inside it, which git would save in plain text. Use an address without one and let your git credential helper or an SSH key sign in. Nothing was changed.");
      const repo = old?.kind === "git" && old.target === target && old.repo ? old.repo : join(o.dataDir, "sync-repo");
      if (!existsSync(repo)) {
        if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) throw new SyncStop("git is not installed (or not on PATH). Install git, or use a shared folder instead (monomem sync setup <folder>).");
        io.out(`Getting ${scrubUrls(target)} ...`);
        const r = spawnSync("git", ["clone", "--quiet", target, repo], { encoding: "utf8", timeout: 300_000, env: { ...o.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: o.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" } });
        if (r.status !== 0) throw new SyncStop(`git could not get ${scrubUrls(target)}: ${scrubUrls((r.stderr ?? "").trim().split("\n").slice(-1)[0] ?? "")}. Check the address and that this computer can sign in to it (git clone works in a terminal), then try again.`);
      } else {
        const url = spawnSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).stdout?.trim();
        if (url !== target) throw new SyncStop(`${repo} already holds a copy of another address (${scrubUrls(url || "none")}). Move that folder away, then run setup again.`);
      }
      c = { kind: "git", target, repo, keyFile, auto: o.auto ?? old?.auto ?? false, everyMinutes: o.everyMinutes ?? old?.everyMinutes ?? DEFAULT_EVERY_MINUTES };
    } else {
      const folder = resolve(target);
      mkdirSync(folder, { recursive: true });
      c = { kind: "folder", target: realpathSync(folder), keyFile, auto: o.auto ?? old?.auto ?? false, everyMinutes: o.everyMinutes ?? old?.everyMinutes ?? DEFAULT_EVERY_MINUTES };
    }
    if (c.everyMinutes < MIN_EVERY_MINUTES) throw new SyncStop(`--every must be at least ${MIN_EVERY_MINUTES} minutes.`);
    writeSyncConfig(o.dataDir, c);
    const code = await runConfiguredSync(io, o);
    if (code !== 0) return code;
    io.out("");
    io.out("Set up. Next steps:");
    io.out(`  1. Copy the key file ${keyFile} to your other computer, into its Monomem data folder with the same name (.sync-key).`);
    io.out("     Use a USB stick or your password manager. NEVER put it in the sync folder or the repository.");
    io.out(`  2. On the other computer, run: monomem sync setup ${c.kind === "git" ? scrubUrls(target) : "<the same shared folder there>"}`);
    io.out(
      c.auto
        ? `  3. Sync runs by itself every ${c.everyMinutes} minutes while Monomem is running (restart Monomem once so it starts). Turn off: monomem sync setup --auto off`
        : "  3. Run `monomem sync` whenever you switch computers, or let it run by itself: monomem sync setup --auto on"
    );
    return 0;
  } catch (e) {
    io.err("Stopped: " + scrubUrls((e as Error).message));
    return 1;
  }
}

/**
 * The server's timer (src/start.ts): only when `sync setup --auto on` was chosen. Each tick re-reads the setting (turning it
 * off works without a restart) and runs `monomem sync` as a child process, one at a time.
 */
export function startSyncTimer(dataDir: string, launch: () => { command: string; args: string[] }, log: (l: string) => void): void {
  const c = readSyncConfig(dataDir);
  if (!c?.auto) return;
  log(`[monomem] device sync every ${c.everyMinutes} min (${c.kind === "git" ? "git" : "shared folder"}); turn off: monomem sync setup --auto off`);
  let running = false;
  const tick = (): void => {
    if (running || !readSyncConfig(dataDir)?.auto) return;
    running = true;
    const { command, args } = launch();
    const child = spawn(command, [...args, "sync"], { stdio: "ignore", windowsHide: true, env: process.env });
    const done = (): void => void (running = false);
    child.on("exit", done);
    child.on("error", done);
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, c.everyMinutes * 60_000).unref();
}

/** `monomem sync` (bare) and `monomem sync setup ...`, from cli.ts. */
export async function syncCli(args: string[]): Promise<number> {
  const { DB_PATH, DATA_DIR } = await import("../config.js");
  const { parseFlags, str, terminalIO } = await import("../cli/shared.js");
  const env = { dataDir: DATA_DIR, dbPath: DB_PATH, env: process.env };
  if (args[0] !== "setup") return runConfiguredSync(terminalIO(), env);
  const { flags, rest } = parseFlags(args.slice(1), { values: ["auto", "every", "name"], bools: [] });
  const auto = str(flags.auto);
  const every = str(flags.every) !== undefined ? Number(str(flags.every)) : undefined;
  if ((auto !== undefined && auto !== "on" && auto !== "off") || (every !== undefined && !Number.isInteger(every))) {
    console.error("Usage: monomem sync setup <private git address | shared folder> [--auto on|off] [--every minutes] [--name label]");
    return 1;
  }
  return setupSync(terminalIO(), {
    ...env,
    target: rest[0],
    ...(auto ? { auto: auto === "on" } : {}),
    ...(every !== undefined ? { everyMinutes: every } : {}),
    ...(str(flags.name) !== undefined ? { name: str(flags.name) } : {}),
  });
}
