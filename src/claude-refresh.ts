// The Claude Code memory bridge (PLAN C16): what `import --claude` remembers between runs, the `monomem check` line, and
// the opt-in refresh while the server runs.
//
// <data dir>/claude-import-state.json records, per file imported (by its real path): the hash of its text and the stable
// keys (source locs) of the notes it became. With it, a second run reads again only the files whose text changed, and a
// file that is gone (Claude Code removed or renamed it) is reported with the notes Monomem still keeps from it.
//
// What the bridge can and cannot see (Claude Code's documented limits, https://code.claude.com/docs/en/memory): auto memory
// is per machine (nothing comes from another computer), Claude Code loads only the first 200 lines / 25 KB of MEMORY.md at
// session start, and auto memory is not written from subagents. The bridge reads the files on this computer; it does not
// change what Claude Code itself loads.
//
// The refresh while the server runs is off unless switched on: MONOMEM_CLAUDE_REFRESH=on, or the dashboard's Settings
// switch (ui-settings.json "claude_refresh"); the variable wins when set. Notes it brings in are held like any import.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uiSwitch } from "./prompt/switches.js";
import type { SetupEnv, SetupIO } from "./setup.js";
import type { Store } from "./store.js";
import { parseTags } from "./store/rows.js";

/** The tag every note from `import --claude` carries. */
export const IMPORT_TAG = "claude-import";
export const STATE_FILE = "claude-import-state.json";
/** How often the server looks for changed files when the refresh is on. */
export const BRIDGE_EVERY_MS = 10 * 60_000;

export interface FileState {
  display: string;
  hash: string;
  locs: string[];
  /** Sections the memory linter held (they wait in `monomem review held`, not as notes). */
  held?: number;
}
export interface BridgeState {
  last_import?: string;
  files: Record<string, FileState>;
}

const statePath = (dbPath: string): string => join(dirname(dbPath), STATE_FILE);

export function readBridgeState(dbPath: string): BridgeState {
  try {
    const j = JSON.parse(readFileSync(statePath(dbPath), "utf8")) as { last_import?: unknown; files?: unknown };
    const files: Record<string, FileState> = {};
    if (j.files && typeof j.files === "object") {
      for (const [k, v] of Object.entries(j.files as Record<string, Partial<FileState>>)) {
        if (v && typeof v.hash === "string" && Array.isArray(v.locs)) files[k] = { display: typeof v.display === "string" ? v.display : k, hash: v.hash, locs: v.locs.filter((x): x is string => typeof x === "string"), ...(typeof v.held === "number" && v.held > 0 ? { held: v.held } : {}) };
      }
    }
    return { ...(typeof j.last_import === "string" ? { last_import: j.last_import } : {}), files };
  } catch {
    return { files: {} };
  }
}

export function writeBridgeState(dbPath: string, s: BridgeState): void {
  const p = statePath(dbPath);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, p);
}

/** Hash of a file's text, or null when it cannot be read. */
export function fileHash(real: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(real)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/** Files recorded at the last import that are no longer on disk. */
export function vanishedFiles(state: BridgeState): Array<[string, FileState]> {
  return Object.entries(state.files).filter(([real]) => !existsSync(real));
}

export function bridgeOn(env: NodeJS.ProcessEnv, dataDir: string): boolean {
  const v = (env.MONOMEM_CLAUDE_REFRESH ?? "").trim();
  if (v) return /^(on|1|true|yes)$/i.test(v);
  return uiSwitch(dataDir, "claude_refresh") === "on";
}

export interface BridgeStatus {
  /** Claude Code memory files on this computer now (CLAUDE.md files of the current folder included). */
  files: number;
  /** New or changed since the last import. */
  changed: number;
  gone: number;
  last_import?: string;
}

export async function bridgeStatus(e: Pick<SetupEnv, "home" | "env" | "cwd">, dbPath: string, noProject = false): Promise<BridgeStatus> {
  const { discoverSources } = await import("./claude-import.js");
  const state = readBridgeState(dbPath);
  const { files } = discoverSources(e, { noProject });
  const changed = files.filter((f) => state.files[f.real]?.hash !== fileHash(f.real)).length;
  return { files: files.length, changed, gone: vanishedFiles(state).length, ...(state.last_import ? { last_import: state.last_import } : {}) };
}

/** Imported Claude Code notes nobody has confirmed yet. */
export function heldImports(s: Store, tag = IMPORT_TAG): number {
  return s.unconfirmedRows().filter((r) => parseTags(r.tags).includes(tag)).length;
}

/** The `monomem check` line, or null when Claude Code keeps no memory here and nothing was ever imported. */
export async function bridgeLine(e: Pick<SetupEnv, "home" | "env" | "cwd">, dbPath: string, held: number): Promise<string | null> {
  const st = await bridgeStatus(e, dbPath);
  if (!st.last_import) return st.files ? `Claude Code keeps its own memory here (${st.files} file(s)) that your other apps do not see: monomem import --claude brings a copy in, unconfirmed (from outside) until you confirm it` : null;
  return `last import ${st.last_import.slice(0, 16).replace("T", " ")}; ${st.changed} file(s) new or changed since${st.gone ? `, ${st.gone} gone (Monomem still has their notes)` : ""}; ${held} imported note(s) unconfirmed (from outside) until you confirm them (monomem review; monomem confirm <id>)`;
}

/** One refresh while the server runs: only when switched on and a file changed or went away. Never throws. */
export async function bridgeTick(e: Pick<SetupEnv, "home" | "env" | "cwd">, dbPath: string, dataDir: string, log: (s: string) => void): Promise<void> {
  try {
    if (!bridgeOn(e.env, dataDir)) return;
    const st = await bridgeStatus(e, dbPath, true);
    if (!st.changed && !st.gone) return;
    const { runClaudeImport } = await import("./claude-import.js");
    const lines: string[] = [];
    const io: SetupIO = { interactive: false, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => "" };
    const code = await runClaudeImport(e, io, { dryRun: false, yes: true, update: true, projects: [], noProject: true, includeIndex: false, dbPath });
    const said = lines.filter((l) => /^(Imported|Claude Code's memory file)/.test(l.trim()));
    log(`[monomem] Claude Code memory refresh${code ? " had a problem" : ""}: ${said.join(" ").slice(0, 400) || "nothing new"}`);
  } catch (err) {
    log(`[monomem] Claude Code memory refresh failed: ${(err as Error).message}`);
  }
}

/**
 * Setup's offer (asks first; never imports without a yes): Claude Code's own memory files on this computer, brought in held.
 * Shown only when there are some and nothing was imported yet. A second question offers the refresh while the server runs.
 */
export async function offerClaudeMemoryImport(e: SetupEnv, io: SetupIO, yes: boolean, db: string): Promise<void> {
  const st = await bridgeStatus(e, db, true);
  if (!st.files || st.last_import) return;
  const intro = `Claude Code keeps its own memory on this computer (${st.files} file(s): CLAUDE.md and its auto memory), which your other apps do not see.`;
  if (!io.interactive || yes) {
    io.out(`\n${intro} To bring a copy in, unconfirmed (from outside) until you confirm it: monomem import --claude`);
    return;
  }
  io.out(`\n${intro}`);
  io.out("  Monomem copies what is in those files, on this computer only. Claude Code itself still loads only the first 200 lines");
  io.out("  (25 KB) of MEMORY.md, keeps auto memory per machine, and does not write it from subagents.");
  const a = (await io.ask("Bring a copy into Monomem now? Each note stays unconfirmed (from outside) until you confirm it. Type y, or press Enter to skip: ")).trim().toLowerCase();
  if (a !== "y" && a !== "yes") return;
  const { runClaudeImport } = await import("./claude-import.js");
  await runClaudeImport(e, io, { dryRun: false, yes: true, update: false, projects: [], noProject: true, includeIndex: false, dbPath: db });
  const b = (await io.ask("Keep bringing in the files Claude Code changes, while Monomem's server runs (every 10 minutes, held the same way)? Type y, or press Enter for no: ")).trim().toLowerCase();
  if (b !== "y" && b !== "yes") return;
  const { updateUiSettings } = await import("./ui/settings.js");
  updateUiSettings({ claude_refresh: "on" }, dirname(db));
  io.out("  On. Turn it off in the dashboard's Settings, or with MONOMEM_CLAUDE_REFRESH=off.");
}
