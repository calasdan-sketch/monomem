// `monomem setup --action-guard`: add the action guard (action-guard.ts) to Claude Code's settings, after showing the exact change
// and a typed yes (--yes skips the question, --dry-run only shows it). Recorded in the setup history like every setup change,
// so `monomem setup --undo` takes it out again (and `monomem uninstall` removes it with the other Monomem hooks).
// Opt-in only: plain `monomem setup` never adds it.
// The gate only knows a session read outside content through the automatic memory (capture) hooks. Without them it can never
// ask, so setup never adds it alone (r4 ease N7): it offers to add the capture hooks in the same change (--yes adds them),
// or refuses and names the command. `monomem check` reports the gate's state (actionGuardStatus).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPath, parseDoc } from "./jsonc-edit.js";
import { buildCaptureCommand, hookHosts, lineDiff, planHooks, readHistory, readTextFile, saveHistory, stamp, writeChange, type FileChange, type SetupEnv, type SetupIO, type SetupOptions } from "./setup.js";
import { GATE_ERROR_FILE, GATE_MATCHER } from "./action-guard.js";

export const GATE_MARKER = "hook action-guard";
const CAPTURE_CMD = "monomem setup --capture";

/** What Claude Code's settings have: the gate, and the post-tool capture hook it depends on. */
function settingsState(e: SetupEnv): { text: string; installed: boolean; captureMissing: boolean } {
  const text = readTextFile(hookHosts(e)[0].file) ?? "";
  const doc = text.trim() ? parseDoc(text) : null;
  const span = (on: string): string => {
    const n = doc ? getPath(doc, ["hooks", on]) : null;
    return n ? text.slice(n.start, n.end) : "";
  };
  return { text, installed: span("PreToolUse").includes(GATE_MARKER), captureMissing: !/\bhook post-tool\b/.test(span("PostToolUse")) };
}

/**
 * The settings change that adds the gate (null when it is already there). With `withCapture`, the same change also adds the
 * automatic memory hooks the gate needs (when they are missing), so one history entry and one undo cover both.
 */
export function planActionGuard(e: SetupEnv, opts: SetupOptions, withCapture = false): { change: FileChange | null; captureMissing: boolean; conflict?: string } {
  const host = hookHosts(e)[0]; // Claude Code: the only host with PreToolUse "ask"
  const { text, installed, captureMissing } = settingsState(e);
  if (installed) return { change: null, captureMissing };
  const db = opts.db ?? (opts.home ? join(opts.home, "state.db") : undefined);
  const value = { matcher: GATE_MATCHER, hooks: [{ type: "command", command: buildCaptureCommand(e, opts, "action-guard", db) }] };
  const gate: FileChange = {
    client: host.client,
    label: "Claude Code action guard",
    file: host.file,
    before: text || null,
    ops: [{ op: "append", path: ["hooks"], key: "PreToolUse", value }],
    inverse: [{ op: "unappend", path: ["hooks"], key: "PreToolUse", marker: GATE_MARKER }],
    lines: ["ask you before git push, a package publish, a web request to a host not on your known-hosts list, or touching .env / .ssh / credential files, once the session has read outside content (a speed bump, not a sandbox)"],
    allowEmpty: opts.forceEmpty,
  };
  if (!withCapture || !captureMissing) return { change: gate, captureMissing };
  const cap = planHooks(e, opts, db, { recall: true, capture: true }, host);
  if (cap.conflict) return { change: null, captureMissing, conflict: cap.conflict };
  if (!cap.change) return { change: gate, captureMissing };
  return {
    captureMissing,
    change: {
      ...gate,
      label: "Claude Code action guard + automatic memory hooks",
      ops: [...cap.change.ops, ...gate.ops],
      inverse: [...gate.inverse, ...cap.change.inverse],
      lines: [...cap.change.lines, ...gate.lines],
    },
  };
}

export async function runActionGuardSetup(e: SetupEnv, io: SetupIO, opts: SetupOptions): Promise<number> {
  let state: ReturnType<typeof settingsState>;
  try {
    state = settingsState(e);
  } catch (err) {
    io.err(`I cannot read Claude Code's settings safely (${(err as Error).message}). Nothing was changed.`);
    return 1;
  }
  if (state.installed) {
    io.out("The action guard is already installed. Nothing to change. Take it out with: monomem setup --undo (if it was the last setup), or remove the \"hook action-guard\" entry under PreToolUse.");
    if (state.captureMissing) io.out(`It cannot ask yet: the automatic memory hooks it needs are missing. Add them with: ${CAPTURE_CMD}`);
    return 0;
  }
  const withCapture = state.captureMissing;
  if (withCapture) {
    io.out("The action guard only knows a session read outside content through Monomem's automatic memory hooks, and they are not installed. Without them it would never ask, so they are part of this change.");
  }
  let plan: ReturnType<typeof planActionGuard>;
  try {
    plan = planActionGuard(e, opts, withCapture);
  } catch (err) {
    io.err(`I cannot read Claude Code's settings safely (${(err as Error).message}). Nothing was changed.`);
    return 1;
  }
  const { change } = plan;
  if (plan.conflict || !change) {
    io.err(`${plan.conflict ?? "Nothing to add."} Nothing was changed.`);
    return 1;
  }
  if (change.before === "" && !opts.forceEmpty) {
    io.err(`${change.file} exists but is completely empty; nothing was changed (run with --force-empty if you are sure).`);
    return 1;
  }
  io.out(`What I will do:\n${change.lines.map((l, i) => `  ${i + 1}. ${l}`).join("\n")}`);
  io.out("The guard never blocks anything: Claude Code shows its usual permission prompt with the reason, and you decide. Hosts without these hooks are not covered.");
  io.out("The exact change:");
  const { applyOps } = await import("./jsonc-edit.js");
  for (const l of lineDiff(change.before ?? "", applyOps(change.before ?? "", change.ops), change.file)) io.out("  " + l);
  if (opts.dryRun) {
    io.out("Dry run: nothing was changed.");
    return 0;
  }
  if (!opts.yes) {
    const what = withCapture ? "the action guard and the automatic memory hooks it needs" : "the action guard";
    if (!io.interactive) {
      io.err(`This is not an interactive terminal, so I cannot ask. Nothing was changed. Re-run with --yes to add ${what}, or --dry-run to only look.`);
      return 1;
    }
    const a = (await io.ask(`Add ${what}? Type y to continue, anything else cancels: `)).trim().toLowerCase();
    if (a !== "y" && a !== "yes") {
      io.out(withCapture ? `Cancelled. Nothing was changed. The guard alone could never ask: to add the hooks on their own, run ${CAPTURE_CMD}.` : "Cancelled. Nothing was changed.");
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

/** One line of `monomem check` about the guard (silent L1: a guard that cannot fire, or fails open, must not look fine). */
export interface GateStatusLine { kind: "info" | "ok" | "warn"; text: string; fix?: string }

/** How long a fail-open error stays in `monomem check`. */
const GATE_ERROR_SHOWN_MS = 7 * 24 * 3600_000;

/** The guard's lines for `monomem check`: installed or not, the capture hooks it needs, and its last fail-open error. */
export function actionGuardStatus(e: SetupEnv, dataDir: string, now: number = Date.now()): GateStatusLine[] {
  const st = settingsState(e);
  if (!st.installed) return [{ kind: "info", text: "action guard: not installed (opt-in: monomem setup --action-guard)" }];
  const out: GateStatusLine[] = st.captureMissing
    ? [{ kind: "warn", text: "the action guard is installed, but the automatic memory hooks it needs are not, so it never asks", fix: CAPTURE_CMD }]
    : [{ kind: "ok", text: "action guard installed, with the automatic memory hooks it needs" }];
  const f = join(dataDir, GATE_ERROR_FILE);
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { at?: unknown; error?: unknown };
      const at = typeof j.at === "string" ? Date.parse(j.at) : NaN;
      if (Number.isFinite(at) && now - at < GATE_ERROR_SHOWN_MS) {
        const why = String(j.error ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
        out.push({ kind: "warn", text: `the action guard could not check an action at ${j.at} (${why}), so it let it through without asking`, fix: "if it repeats, run monomem check --verbose and see docs/action-guard.md" });
      }
    } catch {
      out.push({ kind: "warn", text: `the action guard's last-error file ${f} cannot be read`, fix: `delete ${f}` });
    }
  }
  return out;
}
