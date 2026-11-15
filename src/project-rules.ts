// `monomem project-rules` (R2-07, 1.5.0): copy the notes a PERSON stands behind into a fenced block of this repository's
// AGENTS.md or CLAUDE.md, for agents that read only rules files (Cursor, Copilot, any app without MCP).
//
// A rules file is read as instructions, with more weight than a note, so the gate is strict: a note goes in only when a person
// confirmed its current version or pinned it, and it is not unconfirmed outside content, not by a distrusted writer, not
// disputed (R2-01), not flagged (R2-02), not about code that changed (R2-03), not `private`, not held back from session start,
// and its line passes the memory linter again. An admin's confirm or an agent's corroboration is not enough.
// Only the text between the fence lines is ever written; everything outside it is kept byte for byte. Run by a person at a
// terminal (requireOperator, in cli.ts), never from a hook. Rerunning with nothing new changes nothing.
import { existsSync, readFileSync } from "node:fs";
import type { NoteRecord, Store } from "./store.js";
import { needsHumanConfirm } from "./store.js";
import { disputeFields } from "./facts.js";
import { lintContent } from "./lint.js";
import { heldFromSessionStart } from "./taint.js";
import { expiryEnforced } from "./search-service.js";
import { TASK_TAG } from "./task-core.js";
import { HANDOFF_TAG } from "./tasks.js";
import { NEVER_SHOW_TAG } from "./reserved-tags.js";
import { printable } from "./security.js";
import { INVISIBLE_RE } from "./context-inject.js";

export const FENCE_BEGIN = "<!-- monomem:begin v1 -->";
export const FENCE_END = "<!-- monomem:end -->";
export const RULES_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const FENCE_NOTE = "<!-- Written by `monomem project-rules`: the notes a person confirmed or pinned. Change the notes, not this block; run it again to update. -->";
/** ponytail: looks at the 1,000 most recently updated notes; more than that in one namespace and the oldest are not considered. */
const SCAN = 1000;
const LINE_CHARS = 300;

/** Why a note is left out ("" = it goes in). Exported for the tests. */
export function exclusionReason(store: Store, n: NoteRecord, enforce: boolean): string {
  const human = n.confirmed_kind === "human" && n.confirmed_rev === n.rev;
  if (!human && n.pinned !== true) return "no person confirmed this version or pinned it";
  if (needsHumanConfirm(n)) return "outside content no person confirmed";
  if (n.distrusted || store.isDistrusted(n)) return "distrusted writer";
  if (n.sensitivity === "private") return "private";
  if (n.flagged?.length) return "flagged by an agent";
  if (n.code_changed?.length) return "its code changed since";
  if (n.built_on_distrusted || n.unconfirmed || heldFromSessionStart(n, enforce)) return "held back from session start";
  if (disputeFields(store, n).disputed) return "disputed";
  if (lintContent({ body: ruleLine(n) }).length) return "the linter flags its text";
  return "";
}

/** One line per note: `- <title>: <first part of the body> (om:#12)`. Never starts with note text; one printable line. */
export function ruleLine(n: NoteRecord): string {
  const flat = (s: string): string => printable(s.replace(/\s+/g, " ").replace(INVISIBLE_RE, "").trim(), LINE_CHARS).replace(/<!--|-->/g, "");
  const title = flat(n.title);
  const body = flat(n.body);
  const text = body && body !== title ? `${title}: ${body}` : title;
  return `- ${text.slice(0, LINE_CHARS)} (om:#${n.id})`;
}

/** The notes that go in, as lines (oldest id first), and the ones left out with why. */
export function projectableNotes(store: Store, namespace?: string): { lines: string[]; left: Array<{ id: number; why: string }> } {
  const enforce = expiryEnforced(store);
  const notes = store.list({ namespace, limit: SCAN, count: false, withoutTags: [TASK_TAG, HANDOFF_TAG, NEVER_SHOW_TAG] }).notes;
  const lines: string[] = [];
  const left: Array<{ id: number; why: string }> = [];
  for (const n of [...notes].sort((a, b) => a.id - b.id)) {
    const why = exclusionReason(store, n, enforce);
    if (why) left.push({ id: n.id, why });
    else lines.push(ruleLine(n));
  }
  return { lines, left };
}

/** The fenced block for these lines. */
export function renderBlock(lines: readonly string[]): string {
  return [FENCE_BEGIN, FENCE_NOTE, ...lines, FENCE_END].join("\n");
}

/**
 * The file text with `block` in place of the existing fence (or added at the end when there is none). Text outside the fence
 * is kept exactly. Throws when the fence lines are broken (one without the other, twice, or out of order): a person fixes
 * those by hand, Monomem never guesses where its block ends.
 */
export function applyBlock(current: string | null, block: string): string {
  if (current === null || current === "") return block + "\n";
  const b = current.indexOf(FENCE_BEGIN);
  const e = current.indexOf(FENCE_END);
  const count = (s: string): number => current.split(s).length - 1;
  if (b === -1 && e === -1) return current + (current.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
  if (count(FENCE_BEGIN) !== 1 || count(FENCE_END) !== 1 || e < b) {
    throw new Error(`the Monomem block's fence lines (${FENCE_BEGIN} ... ${FENCE_END}) are broken in this file: fix or remove them by hand, then run it again`);
  }
  return current.slice(0, b) + block + current.slice(e + FENCE_END.length);
}

/** The current block text in a file ("" when there is none or the file does not exist). */
export function currentBlock(text: string | null): string {
  if (!text) return "";
  const b = text.indexOf(FENCE_BEGIN);
  const e = text.indexOf(FENCE_END);
  return b !== -1 && e > b ? text.slice(b, e + FENCE_END.length) : "";
}

/** What a run would do: the file's text now and after, and the lines. `after === before` means nothing to write. */
export function planProjectRules(store: Store, path: string, namespace?: string): { before: string | null; after: string; lines: string[]; left: Array<{ id: number; why: string }> } {
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const { lines, left } = projectableNotes(store, namespace);
  return { before, after: applyBlock(before, renderBlock(lines)), lines, left };
}
