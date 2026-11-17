// `monomem setup --action-guard`: add the action guard (action-guard.ts) to Claude Code's settings, after showing the exact change
// and a typed yes (--yes skips the question, --dry-run only shows it). Recorded in the setup history like every setup change,
// so `monomem setup --undo` takes it out again (and `monomem uninstall` removes it with the other Monomem hooks).
// Opt-in only: plain `monomem setup` never adds it.
import { join } from "node:path";
import { getPath, parseDoc } from "./jsonc-edit.js";
import { buildCaptureCommand, hookHosts, lineDiff, readHistory, readTextFile, saveHistory, stamp, writeChange, type FileChange, type SetupEnv, type SetupIO, type SetupOptions } from "./setup.js";
import { GATE_MATCHER } from "./action-guard.js";

export const GATE_MARKER = "hook action-guard";

/** The settings change that adds the gate, or null when it is already there. */
export function planActionGuard(e: SetupEnv, opts: SetupOptions): { change: FileChange | null; captureMissing: boolean } {
  const host = hookHosts(e)[0]; // Claude Code: the only host with PreToolUse "ask"
  const text = readTextFile(host.file) ?? "";
  const doc = text.trim() ? parseDoc(text) : null;
  const span = (on: string): string => {
    const n = doc ? getPath(doc, ["hooks", on]) : null;
    return n ? text.slice(n.start, n.end) : "";
  };
  const captureMissing = !/\bhook post-tool\b/.test(span("PostToolUse"));
  if (span("PreToolUse").includes(GATE_MARKER)) return { change: null, captureMissing };
  const db = opts.db ?? (opts.home ? join(opts.home, "state.db") : undefined);
  const value = { matcher: GATE_MATCHER, hooks: [{ type: "command", command: buildCaptureCommand(e, opts, "action-guard", db) }] };
  return {
    captureMissing,
    change: {
      client: host.client,
      label: "Claude Code action guard",
      file: host.file,
      before: text || null,
      ops: [{ op: "append", path: ["hooks"], key: "PreToolUse", value }],
      inverse: [{ op: "unappend", path: ["hooks"], key: "PreToolUse", marker: GATE_MARKER }],
      lines: ["ask you before git push, a package publish, a web request to a host not on your known-hosts list, or touching .env / .ssh / credential files, once the session has read outside content (a speed bump, not a sandbox)"],
      allowEmpty: opts.forceEmpty,
    },
  };
}

export async function runActionGuardSetup(e: SetupEnv, io: SetupIO, opts: SetupOptions): Promise<number> {
  let plan: ReturnType<typeof planActionGuard>;
  try {
    plan = planActionGuard(e, opts);
  } catch (err) {
    io.err(`I cannot read Claude Code's settings safely (${(err as Error).message}). Nothing was changed.`);
    return 1;
  }
  const { change, captureMissing } = plan;
  if (captureMissing) io.out("Note: the gate only knows a session read outside content through Monomem's automatic memory hooks, which are not installed. Add them first: monomem setup --capture");
  if (!change) {
    io.out("The action guard is already installed. Nothing to change. Take it out with: monomem setup --undo (if it was the last setup), or remove the \"hook action-guard\" entry under PreToolUse.");
    return 0;
  }
  if (change.before === "" && !opts.forceEmpty) {
    io.err(`${change.file} exists but is completely empty; nothing was changed (run with --force-empty if you are sure).`);
    return 1;
  }
  io.out(`What I will do:\n  1. ${change.label}: ${change.lines[0]}`);
  io.out("It never blocks anything: Claude Code shows its usual permission prompt with the reason, and you decide. Hosts without these hooks are not covered.");
  io.out("The exact change:");
  const { applyOps } = await import("./jsonc-edit.js");
  for (const l of lineDiff(change.before ?? "", applyOps(change.before ?? "", change.ops), change.file)) io.out("  " + l);
  if (opts.dryRun) {
    io.out("Dry run: nothing was changed.");
    return 0;
  }
  if (!opts.yes) {
    if (!io.interactive) {
      io.err("This is not an interactive terminal, so I cannot ask. Re-run with --yes to add it, or --dry-run to only look.");
      return 1;
    }
    const a = (await io.ask("Add the action guard? Type y to continue, anything else cancels: ")).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      io.out("Cancelled. Nothing was changed.");
      return 0;
    }
  }
  try {
    const w = writeChange(e, change);
    if (!w) {
      io.out(`${change.file} already had it, unchanged`);
      return 0;
    }
    const all = readHistory(e);
    all.push({ id: stamp(e.now()), at: e.now().toISOString(), version: e.version, changes: [w] });
    saveHistory(e, all);
    io.out(`${change.label}: updated ${change.file}${w.backup ? `\n    backup: ${w.backup}` : " (new file)"}`);
    io.out("Done. Restart Claude Code. Take it out again with: monomem setup --undo");
    return 0;
  } catch (err) {
    io.err(`Stopped: ${(err as Error).message}. Nothing was changed.`);
    return 1;
  }
}
