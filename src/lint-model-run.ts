// The two ways the optional model second opinion (lint-model.ts) is used. Neither is in the synchronous write path.
//  (a) auditNotes: `monomem check --model` over notes already stored.
//  (b) scheduleModelCheck: after an AGENT's write, a fire-and-forget check a moment later. Until it finishes the note carries
//      the ordinary outside/unconfirmed labelling; a model flag then holds it exactly like `check --rescan` does.
// The hold is a note flag (store/flags.ts): the note stays stored and unedited, leaves session start, and
// `monomem review keep <id>` puts it back. The flag text is FIXED: the model's reason is shown only to the owner at the
// terminal, never stored where an agent could read it (it is derived from untrusted note text).
import type { Store } from "./store.js";
import { lintContent } from "./lint.js";
import { printable } from "./security.js";
import { hasOpenFlag, holdByRescan } from "./store/flags.js";
import { HUMAN_WRITER_MARKERS } from "./actor.js";
import { classifyNote, holdWanted, modelLintConfig, type ModelLintConfig, type ModelVerdict } from "./lint-model.js";

export const MODEL_CHECK_WRITER = "monomem:model-check";
export const MODEL_HOLD_REASON = "second opinion from a local model flagged this note as instruction-like (best-effort, can be wrong)";
const DEFAULT_DELAY_MS = 500;
const MAX_QUEUE = 50;

type Classify = (cfg: ModelLintConfig, note: { title: string; body: string }) => Promise<ModelVerdict | null>;

export interface AuditRow {
  id: number;
  namespace: string;
  title: string;
  /** The pattern linter already matches it today (injection or secret). */
  lintHit: boolean;
  verdict: ModelVerdict | null;
  /** What --hold would do: "hold", "skip" (a person pinned or confirmed it, or it is already flagged), or "none". */
  action: "hold" | "skip" | "none";
  ms: number;
}

const protectedNote = (n: { pinned?: boolean; confirmed_kind?: unknown }): boolean => Boolean(n.pinned) || n.confirmed_kind === "human";

/** Ask the model about every live note (one at a time). Changes nothing; `holdAudit` applies it. */
export async function auditNotes(
  store: Store,
  cfg: ModelLintConfig,
  opts: { namespace?: string; limit?: number; classify?: Classify; onProgress?: (done: number, total: number) => void } = {}
): Promise<AuditRow[]> {
  const classify = opts.classify ?? classifyNote;
  const ids: number[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = store.listIds({ namespace: opts.namespace, limit: 200, offset });
    ids.push(...page);
    if (page.length < 200) break;
  }
  const todo = opts.limit ? ids.slice(0, opts.limit) : ids;
  const rows: AuditRow[] = [];
  for (const id of todo) {
    const n = store.read(id); // gate-ok: the owner at a terminal auditing their own store; nothing here goes to an agent
    if (!n) continue;
    const lintHit = lintContent({ title: n.title, body: n.body, tags: n.tags, writer: n.written_by }).some((f) => f.category === "injection" || f.category === "secret");
    const t0 = Date.now();
    const verdict = await classify(cfg, { title: n.title, body: n.body });
    const want = holdWanted(false, verdict);
    const action: AuditRow["action"] = !want ? "none" : protectedNote(n) || hasOpenFlag(store, n.id, n.rev) ? "skip" : "hold";
    rows.push({ id: n.id, namespace: n.namespace, title: printable(n.title, 80), lintHit, verdict, action, ms: Date.now() - t0 });
    opts.onProgress?.(rows.length, todo.length);
  }
  return rows;
}

/** Hold the rows the audit marked "hold" (re-checked against the note's current rev). Returns how many were held. */
export function holdAudit(store: Store, rows: AuditRow[]): number {
  let held = 0;
  for (const r of rows) {
    if (r.action !== "hold") continue;
    const n = store.read(r.id); // gate-ok: the owner's own command
    if (!n || protectedNote(n) || hasOpenFlag(store, n.id, n.rev)) continue;
    holdByRescan(store, n, MODEL_CHECK_WRITER, MODEL_HOLD_REASON);
    held++;
  }
  return held;
}

// ---- background pass ------------------------------------------------------

const queue: Array<() => Promise<void>> = [];
let running: Promise<void> | null = null;

async function pump(): Promise<void> {
  for (let job = queue.shift(); job; job = queue.shift()) {
    try {
      await job();
    } catch {
      /* a failed check changes nothing */
    }
  }
  running = null;
}

/** Test hook: resolves when every scheduled check has finished. */
export async function drainModelChecks(): Promise<void> {
  while (running || queue.length) await (running ?? Promise.resolve());
}

/**
 * After an agent's write: check the note a moment later with the local model; flag it if the model says instruction-like.
 * Does nothing when the feature is off, for the owner's own writes (cli, server, imports: they are not scanned), or when
 * the queue is full. Never throws, never blocks the caller.
 */
export function scheduleModelCheck(store: Store, note: { id: number; rev: number; written_by?: string }, env: NodeJS.ProcessEnv = process.env, classify: Classify = classifyNote): void {
  try {
    const cfg = modelLintConfig(env);
    if (!cfg) return;
    const w = note.written_by ?? "";
    if (w === "" || (HUMAN_WRITER_MARKERS as readonly string[]).includes(w)) return;
    if (queue.length >= MAX_QUEUE) return;
    const d = Number(env.MONOMEM_LINT_MODEL_DELAY_MS);
    const delay = Number.isFinite(d) && d >= 0 ? d : DEFAULT_DELAY_MS;
    const job = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, delay));
      const n = store.read(note.id); // gate-ok: Monomem's own background check
      if (!n || n.rev !== note.rev || protectedNote(n) || hasOpenFlag(store, n.id, n.rev)) return;
      const verdict = await classify(cfg, { title: n.title, body: n.body });
      if (!holdWanted(false, verdict)) return;
      const again = store.read(note.id); // gate-ok: same
      if (!again || again.rev !== note.rev || protectedNote(again) || hasOpenFlag(store, again.id, again.rev)) return;
      holdByRescan(store, again, MODEL_CHECK_WRITER, MODEL_HOLD_REASON);
    };
    queue.push(job);
    if (!running) running = pump();
  } catch {
    /* never affects the write */
  }
}
