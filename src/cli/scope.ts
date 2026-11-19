
// `monomem scope [status|on|off|adopt <old-project>]`: keep each git repository's notes apart (per-project scope), without a spaces map.
// on / off change only the `auto-scope` file in the data dir and never move, edit or delete a note.
// adopt is the one that moves notes: it re-labels the notes of an old project name into this folder's project.

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

/** Every project name that holds notes, with its count (live notes), or [] when there is no store. */
async function projectCounts(): Promise<Array<{ namespace: string; notes: number }>> {
  const { DB_PATH } = await import("../config.js");
  if (!existsSync(DB_PATH)) return [];
  const { Store } = await import("../store.js");
  const s = new Store(DB_PATH);
  try {
    return s.rebuildPlan().map((r) => ({ namespace: r.namespace, notes: r.notes }));
  } finally {
    s.close();
  }
}

async function status(): Promise<void> {
  const mode = autoScopeMode();
  const root = findRepoRoot(process.cwd());
  if (namespaceConfigSource()) {
    out("A spaces map is set (MONOMEM_SPACES or spaces.json). It decides which project a folder belongs to, so per-repo scope is not used.");
    return;
  }
  out(`Per-project scope: ${mode.on ? "ON" : "OFF"}${mode.source === "env" ? ` (set by ${AUTO_SCOPE_ENV})` : mode.source === "file" ? " (set by monomem scope on)" : " (default for stores that already have notes)"}`);
  if (mode.invalid) out(`Note: ${AUTO_SCOPE_ENV} is set to "${mode.invalid}", which is not understood (use 1 or 0), so it is ignored.`);
  if (!mode.on) {
    out("Every project shares one space. Turn it on with: monomem scope on");
    return;
  }
  const mine = root ? autoScopeName(root) : null;
  out(root ? `This folder is in the repository ${root}, so its notes go to the project "${mine}".` : "This folder is not inside a git repository, so it uses the shared space.");
  out("Limit: an app started outside any repository (a global app setting, for example) is not scoped, and can still search every project's notes.");
  try {
    const others = (await projectCounts()).filter((p) => p.namespace !== mine);
    if (others.length) {
      const { printable } = await import("../security.js");
      const shown = others.slice(0, 20).map((p) => `${printable(p.namespace, 100)} (${p.notes} note${p.notes === 1 ? "" : "s"})`);
      out(`Other projects: ${shown.join(", ")}${others.length > 20 ? `, and ${others.length - 20} more` : ""}`);
      if (mine) out("Notes saved under an old project name (a repository that was moved or renamed) can be brought here: monomem scope adopt <name>");
    }
  } catch {
    /* the store could not be read: the check and doctor commands say why */
  }
}

/** `monomem scope adopt <old-project> [--yes]`: re-label the notes of `old` so they belong to this folder's project. */
async function adopt(args: string[], yes: boolean): Promise<void> {
  const old = args.find((a) => !a.startsWith("-"));
  if (!old) {
    out("Usage: monomem scope adopt <old-project-name> [--yes]");
    out("Find the names with: monomem scope status   (the \"Other projects\" line)");
    process.exitCode = 2;
    return;
  }
  if (namespaceConfigSource()) {
    out("A spaces map is set, and it decides which project a folder belongs to. Nothing was changed.");
    process.exitCode = 1;
    return;
  }
  if (!autoScopeMode().on) {
    out("Per-project scope is OFF, so there is no project for this folder to bring notes into. Turn it on first: monomem scope on");
    process.exitCode = 1;
    return;
  }
  const root = findRepoRoot(process.cwd());
  if (!root) {
    out("This folder is not inside a git repository, so it has no project of its own. Run this from inside the repository the notes belong to. Nothing was changed.");
    process.exitCode = 1;
    return;
  }
  const mine = autoScopeName(root);
  if (old === mine) {
    out(`"${old}" is already this folder's project. Nothing to do.`);
    return;
  }
  const { DB_PATH } = await import("../config.js");
  const { Store, ValidationError, QuarantinedError } = await import("../store.js");
  const { printable } = await import("../security.js");
  if (!existsSync(DB_PATH)) {
    out("There are no notes yet, so there is nothing to bring over.");
    process.exitCode = 1;
    return;
  }
  const store = new Store(DB_PATH);
  try {
    // Live and archived notes move. A note a newer note replaced is only kept as a record (it cannot be edited), so it stays.
    const ids: number[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = store.listIds({ namespace: old, includeArchived: true, limit: 200, offset });
      ids.push(...page);
      if (page.length < 200) break;
    }
    if (ids.length === 0) {
      const used = store.rebuildPlan().map((r) => printable(r.namespace, 100));
      out(`There are no notes under the project name "${printable(old, 100)}". ${used.length ? `Names in use: ${used.slice(0, 30).join(", ")}${used.length > 30 ? ", ..." : ""}` : "There are no notes in any project yet."}`);
      process.exitCode = 1;
      return;
    }
    const n = ids.length;
    out(`${n} note${n === 1 ? "" : "s"} saved under "${printable(old, 100)}" would be moved into this folder's project "${mine}".`);
    if (!yes) {
      out("Each note keeps its text, its history and its writer; only the project it belongs to changes. Notes saved elsewhere are not touched.");
      out(`To go ahead: monomem scope adopt ${old} --yes`);
      process.exitCode = 1;
      return;
    }
    let moved = 0;
    const left: string[] = [];
    for (const id of ids) {
      try {
        if (store.update(id, { namespace: mine })) moved++;
        else left.push(`#${id} (gone)`);
      } catch (e) {
        left.push(`#${id} (${e instanceof QuarantinedError ? "held for your review" : e instanceof ValidationError ? e.message : (e as Error).message})`);
      }
    }
    try {
      (await import("../security.js")).audit({ op: "scope.adopt", namespace: mine, label: "cli", kind: "note", bytes: moved, detail: `from ${printable(old, 100)}` });
    } catch {
      /* the audit line is a record, not a step the move depends on */
    }
    out(`Moved ${moved} note${moved === 1 ? "" : "s"} from "${printable(old, 100)}" into "${mine}". Their history is kept. Check: monomem ls`);
    if (left.length) {
      out(`${left.length} could not be moved: ${left.slice(0, 10).join("; ")}${left.length > 10 ? "; ..." : ""}`);
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

export async function scopeCmd(): Promise<void> {
  const args = process.argv.slice(3);
  const sub = args.find((a) => !a.startsWith("-")) ?? "status";
  const yes = args.includes("--yes") || args.includes("-y");
  if (sub === "status") return status();
  if (sub === "adopt") {
    const rest = [...args];
    rest.splice(rest.indexOf("adopt"), 1);
    return adopt(rest, yes);
  }
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
    out("Notes belong to the folder path: if you move or rename a repository, it starts a new project and its old notes stay under the old path (monomem scope adopt <old name> brings them over).");
    out("Per-project scope is ON. Each git repository now keeps its own notes, and one repository cannot see another's. A git worktree shares the notes of the repository it was made from.");
    out("Restart your apps so they pick it up. Limit: an app started outside any repository is not scoped and can still search every project's notes.");
    return;
  }
  out("Usage: monomem scope [status|on|off|adopt <old-project>] [--yes]");
  process.exitCode = 2;
}
