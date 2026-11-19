// `monomem scope [status|on|off]`: keep each git repository's notes apart (per-project scope), without a spaces map.
// Changes only the `auto-scope` file in the data dir. It never moves, edits or deletes a note.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AUTO_SCOPE_ENV, AUTO_SCOPE_FILE, autoScopeMode, autoScopeName, findRepoRoot, namespaceConfigSource } from "../namespace.js";

const out = (s = ""): void => void process.stdout.write(s + "\n");

/** Notes already in the store, or 0 when there is no store yet. */
async function noteCount(): Promise<number> {
  const { DB_PATH } = await import("../config.js");
  if (!existsSync(DB_PATH)) return 0;
  const { Store } = await import("../store.js");
  const s = new Store(DB_PATH);
  try {
    return s.countAll();
  } finally {
    s.close();
  }
}

function status(): void {
  const mode = autoScopeMode();
  const root = findRepoRoot(process.cwd());
  if (namespaceConfigSource()) {
    out("A spaces map is set (MONOMEM_SPACES or spaces.json). It decides which project a folder belongs to, so per-repo scope is not used.");
    return;
  }
  out(`Per-project scope: ${mode.on ? "ON" : "OFF"}${mode.source === "env" ? ` (set by ${AUTO_SCOPE_ENV})` : mode.source === "file" ? " (set by monomem scope on)" : " (default for stores that already have notes)"}`);
  if (!mode.on) {
    out("Every project shares one space. Turn it on with: monomem scope on");
    return;
  }
  out(root ? `This folder is in the repository ${root}, so its notes go to the project "${autoScopeName(root)}".` : "This folder is not inside a git repository, so it uses the shared space.");
  out("Limit: an app started outside any repository (a global app setting, for example) is not scoped, and can still search every project's notes.");
}

export async function scopeCmd(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args.find((a) => !a.startsWith("-")) ?? "status";
  const yes = args.includes("--yes") || args.includes("-y");
  if (sub === "status") return status();
  if (sub === "off") {
    rmSync(AUTO_SCOPE_FILE, { force: true });
    out("Per-project scope is OFF. Every project shares one space again. Notes were not changed.");
    if (autoScopeMode().on) out(`Note: ${AUTO_SCOPE_ENV} is still set in this shell and keeps it on.`);
    return;
  }
  if (sub === "on") {
    if (namespaceConfigSource()) {
      out("A spaces map is already set, and it decides which project a folder belongs to. Nothing was changed.");
      process.exitCode = 1;
      return;
    }
    const n = await noteCount();
    if (n > 0 && !yes) {
      out(`This store already has ${n} note${n === 1 ? "" : "s"}. They live in the shared space.`);
      out("Once per-project scope is on, a repository sees only its own notes, so those existing notes will not show inside a repository.");
      out("Nothing is moved or deleted, and `monomem scope off` brings the old view back.");
      out("To go ahead: monomem scope on --yes");
      process.exitCode = 1;
      return;
    }
    mkdirSync(dirname(AUTO_SCOPE_FILE), { recursive: true });
    writeFileSync(AUTO_SCOPE_FILE, "on\n", { mode: 0o600 });
    if (process.env[AUTO_SCOPE_ENV] && !autoScopeMode().on) {
      out(`Saved, but ${AUTO_SCOPE_ENV} is set to turn it off in this shell, and that wins. Unset it to use the saved setting.`);
      return;
    }
    out("Notes belong to the folder path: if you move or rename a repository, it starts a new project and its old notes stay under the old path.");
    out("Per-project scope is ON. Each git repository now keeps its own notes, and one repository cannot see another's.");
    out("Restart your apps so they pick it up. Limit: an app started outside any repository is not scoped and can still search every project's notes.");
    return;
  }
  out("Usage: monomem scope [status|on|off] [--yes]");
  process.exitCode = 2;
}
