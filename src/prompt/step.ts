// C17: the one prompt-time step (UserPromptSubmit). One store, opened once by the hook, then in order:
//   1. new by others   notes other writers saved since the previous prompt (context-inject newNotesSince; always on)
//   2. retired notices a note this session was shown (memory_receipts) was since replaced, archived or flagged: said once
//   3. known fixes     a command that failed since the previous prompt has a bugfix note from an earlier session
//   4. recall top 3    the prompt's rarest <= 6 keywords, keyword search only, titles + tags only on an encrypted store
//                      (the hook never builds the body index), at most 2 of the 3 from one writer when others match too,
//                      never a note this session was already shown
// Steps 2-4 are OFF by default (MONOMEM_PROMPT_RECALL=on turns them on) until they are measured on the bundled build.
// Pushes go on the same receipt as session start (why=prompt), so "shown once per session" covers every push; with
// receipts off (MONOMEM_ACCESS_LOG_DAYS=0) steps 2-4 push nothing rather than repeat themselves. Each step fails open.
import type { NoteRecord, Store } from "../store.js";
import { NOTE_KINDS } from "../store.js";
import { extractKeywords } from "../keywords.js";
import { anyKeywordHits, expiryEnforced } from "../search-service.js";
import { indexLine, newNotesSince, openToolName } from "../context-inject.js";
import { NEVER_SHOW_TAG } from "../reserved-tags.js";
import { CHAT_TAG } from "../chat-import.js";
import { TASK_TAG, HANDOFF_TAG } from "../tasks.js";
import { heldFromSessionStart } from "../taint.js";
import { titleText } from "../recall.js";
import { eventInput } from "../capture.js";
import { noticesMark, noticesSaid, receiptAppend, receiptShown } from "../receipts.js";
import { accessLogDays } from "../store.js";

/** Search time budget of step 4 (ms). A budget, not a guarantee: SQLite work cannot be interrupted, so it is checked around it. */
export const PROMPT_BUDGET_MS = 150;
export const PROMPT_RECALL_LIMIT = 3;
export const PROMPT_KEYWORDS = 6;
const PER_WRITER = 2;
const MAX_NOTICES = 3;
const HIDDEN = [NEVER_SHOW_TAG, CHAT_TAG, TASK_TAG, HANDOFF_TAG];

/** MONOMEM_PROMPT_RECALL: "on" turns steps 2-4 on. Default off (see the header). */
export function promptRecallOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true|yes)$/i.test((env.MONOMEM_PROMPT_RECALL ?? "").trim());
}

export interface PromptStepOpts {
  namespace?: string;
  /** The session's own writer, when the hook knows it: its own new notes are not news. */
  notWrittenBy?: string;
  /** Steps 2-4 on (MONOMEM_PROMPT_RECALL). */
  recall: boolean;
  client?: string;
  /** Test hook: the clock for the budget. */
  clock?: () => number;
}

export interface PromptStepResult {
  /** The lines for inside the untrusted block ("" = nothing to say). */
  text: string;
  /** Monomem's own cost line (outside the block), "" when steps 2-4 are off or said nothing. */
  cost: string;
  /** Note ids pushed by step 4. */
  recalled: number[];
}

const one = (s: string, max: number): string => {
  const c = (s || "").replace(/\s+/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
};
const hidden = (n: NoteRecord): boolean => n.tags.some((t) => HIDDEN.includes(t));

/** Step 2: notes this session was shown that were replaced, archived or flagged after it was shown them, said once. */
export function retiredNotices(store: Store, sessionId: string, shown: Map<number, string>, said: Set<string>): { lines: string[]; marks: Array<{ id: number; kind: string }> } {
  const lines: string[] = [];
  const marks: Array<{ id: number; kind: string }> = [];
  for (const [id, at] of shown) {
    if (lines.length >= MAX_NOTICES) break;
    if (said.has(`${id}:retired`)) continue;
    // Through the read gate: a note this reader may no longer see is "no longer available", never told apart from deleted.
    const n = store.readVisible(id); // gate-ok: the session was shown this id; the gate decides what more it may learn
    const flag = n?.flagged?.find((f) => f.at > at);
    const kind = !n ? "gone" : n.superseded_at && n.superseded_at > at ? "replaced" : n.archived_at && n.archived_at > at ? "archived" : flag ? "flagged" : "";
    if (!kind) continue;
    const what = n ? `#${id} "${one(titleText(n.title), 80)}"` : `#${id}`;
    let line: string;
    if (kind === "replaced" && n?.superseded_by) {
      const by = store.readVisible(n.superseded_by); // gate-ok: a replacement above this reader's ceiling is not named
      if (by && by.session_id === sessionId) continue; // this session made the change: not news
      line = by ? `${what}, which you were shown, was replaced by #${by.id} (${one(by.written_by, 24)}).` : `${what}, which you were shown, was replaced by a note you cannot see.`;
    } else if (kind === "flagged") line = `${what}, which you were shown, was flagged as possibly wrong by ${one(flag?.by ?? "", 24)}.`;
    else if (kind === "gone") line = `${what}, which you were shown, is no longer available (deleted, archived or hidden).`;
    else line = `${what}, which you were shown, was archived.`;
    lines.push(line);
    marks.push({ id, kind: "retired" });
  }
  return { lines, marks };
}

/** The bugfix title extract.ts writes for a command it saw fail and then pass. */
const fixTitle = (cmd: string): string => `Fixed failing \`${one(cmd, 90)}\``;
function commandOf(input: string): string {
  try {
    const v = JSON.parse(input) as unknown;
    if (v && typeof v === "object" && typeof (v as { command?: unknown }).command === "string") return (v as { command: string }).command;
  } catch {
    /* not JSON (cut at the field limit) */
  }
  const m = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  if (!m) return "";
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

/** Step 3: a shell command that failed since the previous prompt, with a bugfix note from another session. Said once per note. */
export function knownFixNotices(store: Store, sessionId: string, said: Set<string>, namespace?: string): { lines: string[]; marks: Array<{ id: number; kind: string }> } {
  const lines: string[] = [];
  const marks: Array<{ id: number; kind: string }> = [];
  const db = store.captureDb();
  const prev = db.prepare("SELECT seq FROM capture_events WHERE session_id = ? AND event = 'user-prompt' ORDER BY seq DESC LIMIT 1 OFFSET 1").get(sessionId) as { seq: number } | undefined;
  const failed = db
    .prepare("SELECT seq, input, input_enc FROM capture_events WHERE session_id = ? AND seq > ? AND tool = 'Bash' AND ok = 0 ORDER BY seq DESC LIMIT 20")
    .all(sessionId, prev?.seq ?? 0) as Array<{ seq: number; input: string; input_enc: string | null }>;
  const titles = [...new Set(failed.map((r) => commandOf(eventInput(store, r, sessionId))).filter(Boolean).map(fixTitle))];
  if (!titles.length) return { lines, marks };
  const enforce = expiryEnforced(store);
  // ponytail: the 200 newest bugfix notes; an older fix is not recalled here (search still finds it).
  const fixes = store.list({ namespace, kinds: ["observation"], obsTypes: ["bugfix"], limit: 200, count: false }).notes.filter((n) => titles.includes(n.title));
  for (const n of fixes) {
    if (lines.length >= MAX_NOTICES) break;
    const id = n.id;
    if (said.has(`${id}:fix`) || n.session_id === sessionId || hidden(n) || heldFromSessionStart(n, enforce)) continue;
    lines.push(`Seen before: that command failed in an earlier session and was fixed. ${indexLine(n)}`);
    marks.push({ id, kind: "fix" });
  }
  return { lines, marks };
}

/** The prompt's rarest keywords (fewest notes contain them), at most `max`; words no note contains are dropped. */
export function rarestKeywords(store: Store, prompt: string, max = PROMPT_KEYWORDS): string[] {
  const words = extractKeywords(prompt.slice(0, 4000)).map((k) => k.replace(/^#/, "").toLowerCase()).filter((k) => k.length >= 3);
  const uniq = [...new Set(words)].slice(0, 40);
  if (!uniq.length) return [];
  const { n, df } = store.prefixDocFreqs(uniq);
  if (!df.size) return uniq.slice(0, max); // no vocabulary to read: the first words, as typed
  // A word in more than a quarter of the notes says nothing about which one is meant.
  return uniq
    .filter((w) => (df.get(w) ?? 0) > 0 && (df.get(w) ?? 0) <= Math.max(3, n / 4))
    .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0))
    .slice(0, max);
}

/** Step 4: up to 3 notes matching the prompt's rarest keywords that this session was not shown yet. */
export function promptRecall(store: Store, prompt: string, shown: Map<number, string>, opts: { namespace?: string }): NoteRecord[] {
  const keywords = rarestKeywords(store, prompt);
  if (!keywords.length) return [];
  const enforce = expiryEnforced(store);
  const hits = anyKeywordHits(store, keywords, 20, { namespace: opts.namespace, kinds: NOTE_KINDS }).map((h) => h.note).filter((n) => !shown.has(n.id) && !hidden(n) && !heldFromSessionStart(n, enforce) && !n.distrusted);
  const picked: NoteRecord[] = [];
  const count = (w: string): number => picked.filter((p) => p.written_by === w).length;
  for (const n of hits) if (picked.length < PROMPT_RECALL_LIMIT && count(n.written_by) < PER_WRITER) picked.push(n);
  // Only one writer matched: no one else to make room for, so the cap gives way.
  for (const n of hits) if (picked.length < PROMPT_RECALL_LIMIT && !picked.includes(n)) picked.push(n);
  return picked;
}

/** The whole step, on a store the hook already opened. Never throws. */
export function promptStep(store: Store, sessionId: string, prompt: string, opts: PromptStepOpts): PromptStepResult {
  const clock = opts.clock ?? Date.now;
  const t0 = clock();
  const parts: string[] = [];
  let recalled: number[] = [];
  try {
    const fresh = newNotesSince(store, sessionId, { ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}), ...(opts.notWrittenBy ? { notWrittenBy: opts.notWrittenBy } : {}) });
    if (fresh) parts.push(fresh);
  } catch (e) {
    process.stderr.write(`monomem prompt step (new notes): ${(e as Error).message}\n`);
  }
  // Steps 2-4 need the receipt to say things once; without it they stay quiet.
  if (!opts.recall || accessLogDays() === 0) return { text: parts.join("\n\n"), cost: "", recalled };
  const before = parts.join("\n\n").length;
  const shown = receiptShown(store, sessionId);
  const said = noticesSaid(store, sessionId);
  const marks: Array<{ id: number; kind: string }> = [];
  const step = (name: string, fn: () => { lines: string[]; marks: Array<{ id: number; kind: string }> }, head: string): void => {
    try {
      const r = fn();
      if (r.lines.length) parts.push([head, ...r.lines].join("\n"));
      marks.push(...r.marks);
    } catch (e) {
      process.stderr.write(`monomem prompt step (${name}): ${(e as Error).message}\n`);
    }
  };
  const noticeStart = parts.length;
  step("retired", () => retiredNotices(store, sessionId, shown, said), "Changed since you were shown it:");
  step("known fix", () => knownFixNotices(store, sessionId, said, opts.namespace), "Known fix:");
  // Notices are recorded before anything else is said: one that cannot be recorded is not said (it would repeat every prompt).
  if (marks.length && !noticesMark(store, sessionId, marks)) parts.splice(noticeStart);
  if (clock() - t0 <= PROMPT_BUDGET_MS) {
    try {
      const notes = promptRecall(store, prompt, shown, { namespace: opts.namespace });
      // Ledger first: a push that cannot be recorded is not made.
      if (notes.length && receiptAppend(store, { sessionId, namespace: opts.namespace ?? "", client: opts.client ?? "", why: "prompt", shown: notes.map((n) => ({ id: n.id, tokens: Math.ceil((n.title.length + n.body.length) / 4) })) })) {
        parts.push([`May be relevant to this message (titles only; open with ${openToolName()}):`, ...notes.map((n) => indexLine(n))].join("\n"));
        recalled = notes.map((n) => n.id);
        store.logAccess({ tool: "hook:prompt-recall", namespaces: opts.namespace !== undefined ? [opts.namespace] : [], results: notes.length });
      }
    } catch (e) {
      process.stderr.write(`monomem prompt step (recall): ${(e as Error).message}\n`);
    }
  }
  const text = parts.join("\n\n");
  const added = text.length - before;
  const ms = Math.max(0, Math.round(clock() - t0));
  const cost = added > 0 ? `(Monomem prompt step: ~${Math.ceil(added / 4)} tokens, ${ms} ms. MONOMEM_PROMPT_RECALL=off turns it off.)` : "";
  return { text, cost, recalled };
}
