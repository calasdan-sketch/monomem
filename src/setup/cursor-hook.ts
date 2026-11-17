// Cursor's start-of-session hook (cursor.com/docs/hooks, checked 2026-11-17): user hooks live in ~/.cursor/hooks.json as
// {"version": 1, "hooks": {"sessionStart": [{"command": "..."}]}}; the command gets {session_id, workspace_roots, ...} on
// stdin and answers {"additional_context": "..."}, which Cursor adds to the conversation's starting context. The command is
// `monomem hook cursor-session-start` (hook.ts), which prints the same notes as Claude Code's session-start hook.
// Only this one hook: Cursor's other events are not wired (see docs/apps.md).
import { getPath, parseDoc, type Op } from "../jsonc-edit.js";
import { buildCaptureCommand, readTextFile, type FileChange, type HookHost, type SetupEnv, type SetupOptions } from "../setup.js";

export const CURSOR_START_EVENT = "cursor-session-start";
const MARKER = `hook ${CURSOR_START_EVENT}`;

export function planCursorHook(e: SetupEnv, opts: SetupOptions, dbForHook: string | undefined, host: HookHost): { change: FileChange | null; already: boolean; conflict?: string } {
  const text = readTextFile(host.file);
  if (text === "" && !opts.forceEmpty) return { change: null, already: false, conflict: `${host.file} exists but is completely empty (0 bytes); run setup again with --force-empty if you are sure` };
  const doc = text && text.trim() ? parseDoc(text) : null;
  const arr = doc ? getPath(doc, ["hooks", "sessionStart"]) : undefined;
  if (arr && text!.slice(arr.start, arr.end).includes(MARKER)) return { change: null, already: true };
  const ops: Op[] = [];
  const inverse: Op[] = [];
  // Cursor reads a hooks file only with "version": 1; one that has none (or a new file) gets it, and undo takes it out again.
  if (!doc || !getPath(doc, ["version"])) {
    ops.push({ op: "set", path: [], key: "version", value: 1 });
    inverse.unshift({ op: "remove", path: [], key: "version" });
  }
  ops.push({ op: "append", path: ["hooks"], key: "sessionStart", value: { command: buildCaptureCommand(e, opts, CURSOR_START_EVENT, dbForHook) } });
  inverse.unshift({ op: "unappend", path: ["hooks"], key: "sessionStart", marker: MARKER });
  return {
    change: { client: host.client, label: host.label, file: host.file, before: text, ops, lines: [`add a start-of-session hook that shows your recent notes to ${host.agent} (your existing hooks stay as they are)`], inverse, allowEmpty: opts.forceEmpty },
    already: false,
  };
}
