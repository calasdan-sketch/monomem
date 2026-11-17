// "What did this note touch?" (plan C23): who was handed one note, and what was built on it afterwards.
//
// Two kinds of answer, always kept apart:
//   proven: Monomem recorded it. A read in the access log (note_reads), a session start that showed it (memory_receipts),
//           a note or task saved with derived_from naming it (note_links, followed up to LINK_DEPTH steps), a note it
//           replaced (supersede_log, still in force).
//   likely: an inference. The same writer that read it created or changed a note, or claimed a task, after the read and
//           within the taint window (MONOMEM_TAINT_WINDOW_HOURS, default 12); or a note written in a session whose start
//           showed it. Nothing says that writer used this note; it is the set to check by hand.
// Read-only. Titles only, never note text. Notes the caller may not see are counted, never named.
// `monomem why <id> --touched`, memory_why touched:true (admin), GET /notes/:id/touched (admin), dashboard "What did this touch?".
// `monomem rollback --note <id>` (rollback.ts) undoes the root and what was built on it from this same answer.

import { taintWindowHours } from "./config.js";
import { accessLogDays, type NoteRecord, type Store } from "./store.js";
import { printable } from "./security.js";
import { readsOf } from "./store/note-reads.js";
import { stateOf, TASK_TAG, TAG_CLAIM } from "./task-core.js";

/** How many derived_from steps away from the note are followed. */
const LINK_DEPTH = 5;
/** Rows per list (the counts stay exact). */
const LIST_MAX = 200;

export type Basis = "proven" | "likely";

export interface TouchedRead {
  at: string;
  /** The server-stamped reader (a token label, stdio:<app>, cli ...); for a session start, the app the hook reported. */
  reader: string;
  via: string;
  /** Session id, for a session start that showed it. */
  session_id?: string;
  proof: "access log" | "receipt";
}
export interface TouchedNote {
  id: number;
  namespace: string;
  title: string;
  task: boolean;
  basis: Basis;
  /** Who made the change that ties it to this note (the derived_from link, or the reader). */
  by: string;
  at: string;
  change: "created" | "changed";
  why: string;
}
export interface TouchedTask {
  id: number;
  namespace: string;
  title: string;
  by: string;
  at: string;
  basis: "likely";
  why: string;
}
export interface Touched {
  id: number;
  namespace: string;
  title: string;
  created_at: string;
  reads: TouchedRead[];
  reads_total: number;
  built_on: TouchedNote[];
  claimed_tasks: TouchedTask[];
  /** Notes this note replaced, still replaced (proven: the replacement log). */
  replaced: Array<{ id: number; namespace: string; title: string; at: string; by: string; basis: "proven" }>;
  /** Notes found but outside what the caller may see: counted, never named. */
  hidden: number;
  window_hours: number;
  retention_days: number;
  not_recorded: string;
}

export const TOUCHED_NOT_RECORDED =
  "Not recorded: reads older than the access-log retention, reads while the access log was switched off, " +
  "what an app did with a note outside Monomem, and notes an app built on it without saying so when it saved them. " +
  "\"likely\" means the same writer wrote after reading; it is not proof that it used this note.";

export interface TouchedOpts {
  /** Confine every listed note to these namespaces (undefined = all). */
  namespaces?: string[];
  /** The local CLI: reads every note. Otherwise the trust gate decides (readVisible). */
  operator: boolean;
}

/** One note, if the caller may see it. */
function visibleTo(store: Store, opts: TouchedOpts): (id: number) => NoteRecord | undefined {
  return (id) => {
    const n = opts.operator ? store.read(id) : store.readVisible(id); // gate-ok: operator path is the CLI; others go through the trust gate
    if (!n || (opts.namespaces && !opts.namespaces.includes(n.namespace))) return undefined;
    return n;
  };
}

/** Every recorded read of the note: the access log's note ids and the session-start receipts. */
function readsFor(store: Store, id: number, namespaces?: string[]): TouchedRead[] {
  const db = store.captureDb();
  const out: TouchedRead[] = readsOf(db, id).map((r) => ({ at: r.at, reader: r.writer, via: r.tool, proof: "access log" as const }));
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_receipts'").get()) {
    const rows = db.prepare("SELECT session_id, at, client, namespace FROM memory_receipts WHERE note_id = ? ORDER BY at").all(id) as Array<{ session_id: string; at: string; client: string; namespace: string }>;
    for (const r of rows) {
      if (namespaces && !namespaces.includes(r.namespace)) continue;
      out.push({ at: r.at, reader: r.client || "session start", via: "session start", session_id: r.session_id, proof: "receipt" });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Notes saved with derived_from naming the note, and notes derived from those (up to LINK_DEPTH steps). */
function linkedFrom(store: Store, id: number): Array<{ id: number; parent: number; depth: number; added_at: string; added_by: string }> {
  return store.db
    .prepare(
      `WITH RECURSIVE d(id, parent, depth, added_at, added_by) AS (
         SELECT note_id, derived_from, 1, added_at, added_by FROM note_links WHERE derived_from = ?
         UNION
         SELECT l.note_id, l.derived_from, d.depth + 1, l.added_at, l.added_by FROM note_links l JOIN d ON l.derived_from = d.id WHERE d.depth < ?
       )
       SELECT id, parent, MIN(depth) AS depth, added_at, added_by FROM d WHERE id <> ? GROUP BY id ORDER BY depth, id LIMIT ?`
    )
    .all(id, LINK_DEPTH, id, LIST_MAX * 5) as Array<{ id: number; parent: number; depth: number; added_at: string; added_by: string }>;
}

/** One reader's window: from its first read to its last read plus the taint window. */
interface Window {
  reader: string;
  from: string;
  to: string;
  session_id?: string;
}

function windowsOf(reads: TouchedRead[], hours: number): Window[] {
  const byReader = new Map<string, Window>();
  const sessions: Window[] = [];
  const end = (at: string): string => new Date(Date.parse(at) + hours * 3_600_000).toISOString();
  for (const r of reads) {
    if (r.session_id) {
      sessions.push({ reader: r.reader, from: r.at, to: end(r.at), session_id: r.session_id });
      continue;
    }
    if (!r.reader) continue;
    const w = byReader.get(r.reader);
    if (!w) byReader.set(r.reader, { reader: r.reader, from: r.at, to: end(r.at) });
    else w.to = end(r.at);
  }
  return [...byReader.values(), ...sessions];
}

/** Notes a reader created or changed in its window (or a session wrote after its start showed the note). */
function writesIn(store: Store, w: Window): Array<{ id: number; at: string; change: "created" | "changed"; by: string }> {
  if (w.session_id) {
    return (store.db.prepare("SELECT id, created_at AS at, created_by AS by FROM notes WHERE session_id = ? AND created_at >= ? ORDER BY created_at LIMIT ?").all(w.session_id, w.from, LIST_MAX) as Array<{ id: number; at: string; by: string }>)
      .map((r) => ({ ...r, change: "created" as const }));
  }
  const created = store.db.prepare("SELECT id, created_at AS at FROM notes WHERE created_by = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at LIMIT ?").all(w.reader, w.from, w.to, LIST_MAX) as Array<{ id: number; at: string }>;
  const changed = store.db
    .prepare("SELECT note_id AS id, MIN(saved_at) AS at FROM note_history WHERE saved_by = ? AND saved_at >= ? AND saved_at <= ? GROUP BY note_id ORDER BY at LIMIT ?")
    .all(w.reader, w.from, w.to, LIST_MAX) as Array<{ id: number; at: string }>;
  return [...created.map((r) => ({ ...r, change: "created" as const, by: w.reader })), ...changed.map((r) => ({ ...r, change: "changed" as const, by: w.reader }))];
}

/** Tasks a reader claimed in its window (the claim tag records who and when). */
function claimsIn(store: Store, windows: Window[], namespaces?: string[]): Array<{ task: NoteRecord; by: string; at: string }> {
  const readers = windows.filter((w) => !w.session_id);
  if (!readers.length) return [];
  const out: Array<{ task: NoteRecord; by: string; at: string }> = [];
  const page = 500;
  for (let offset = 0; ; offset += page) {
    const notes = store.list({ namespaces, limit: page, offset, withTags: [TASK_TAG], withTagPrefix: TAG_CLAIM, count: false }).notes;
    for (const t of notes) {
      const c = stateOf(t).claim;
      if (!c) continue;
      const at = new Date(c.atMs).toISOString();
      if (readers.some((w) => w.reader === c.by && at >= w.from && at <= w.to)) out.push({ task: t, by: c.by, at });
    }
    if (notes.length < page) break;
  }
  return out;
}

/** The whole answer for one note the caller may already see. */
export function noteTouched(store: Store, root: NoteRecord, opts: TouchedOpts): Touched {
  const see = visibleTo(store, opts);
  const hours = taintWindowHours() > 0 ? taintWindowHours() : 12;
  const reads = readsFor(store, root.id, opts.namespaces);
  let hidden = 0;
  const built: TouchedNote[] = [];
  const seen = new Set<number>([root.id]);
  const add = (id: number, f: (n: NoteRecord) => TouchedNote): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = see(id);
    if (!n) return void hidden++;
    built.push(f(n));
  };

  for (const l of linkedFrom(store, root.id)) {
    add(Number(l.id), (n) => ({
      ...base(n),
      basis: "proven",
      by: l.added_by,
      at: l.added_at,
      change: n.created_by === l.added_by && n.created_at <= l.added_at ? "created" : "changed",
      why: l.depth === 1 ? `saved as built on #${root.id}` : `saved as built on #${l.parent}, which is built on #${root.id}`,
    }));
  }
  const windows = windowsOf(reads, hours);
  for (const w of windows) {
    for (const r of writesIn(store, w)) {
      add(Number(r.id), (n) => ({
        ...base(n),
        basis: "likely",
        by: r.by,
        at: r.at,
        change: r.change,
        why: w.session_id ? `written in session ${w.session_id}, whose start showed #${root.id}` : `${r.change} by ${w.reader} after it read #${root.id}`,
      }));
    }
  }
  const claimed: TouchedTask[] = claimsIn(store, windows, opts.namespaces)
    .filter((c) => see(c.task.id))
    .map((c) => ({ id: c.task.id, namespace: c.task.namespace, title: printable(c.task.title, 200), by: c.by, at: c.at, basis: "likely" as const, why: `claimed by ${c.by} after it read #${root.id}` }));

  const reps = store.db
    .prepare("SELECT DISTINCT l.old_id AS id, l.at AS at, l.actor AS by FROM supersede_log l JOIN notes n ON n.id = l.old_id WHERE l.action = 'supersede' AND l.new_id = ? AND n.superseded_by = l.new_id ORDER BY l.old_id")
    .all(root.id) as Array<{ id: number; at: string; by: string }>;
  const replaced: Touched["replaced"] = [];
  for (const r of reps) {
    const n = see(Number(r.id));
    if (!n) hidden++;
    else replaced.push({ id: n.id, namespace: n.namespace, title: printable(n.title, 200), at: r.at, by: r.by, basis: "proven" });
  }

  return {
    id: root.id,
    namespace: root.namespace,
    title: printable(root.title, 200),
    created_at: root.created_at,
    reads: reads.slice(-LIST_MAX),
    reads_total: reads.length,
    built_on: built.slice(0, LIST_MAX),
    claimed_tasks: claimed.slice(0, LIST_MAX),
    replaced,
    hidden,
    window_hours: hours,
    retention_days: accessLogDays(),
    not_recorded: TOUCHED_NOT_RECORDED,
  };
}

function base(n: NoteRecord): { id: number; namespace: string; title: string; task: boolean } {
  return { id: n.id, namespace: n.namespace, title: printable(n.title, 200), task: n.tags.includes(TASK_TAG) };
}

/** Plain-text report (CLI, and the dashboard shows the same lines). */
export function touchedText(t: Touched): string {
  const p = (v: string, max = 80): string => printable(v, max);
  const out = [`What note #${t.id} "${p(t.title)}" [${p(t.namespace, 40)}] touched:`];
  if (!t.reads_total) out.push(`Reads: none recorded (reads are kept ${t.retention_days} days).`);
  else {
    out.push(`Read ${t.reads_total} time(s) (proven: recorded reads):`);
    const byReader = new Map<string, { n: number; first: string; last: string; via: Set<string> }>();
    for (const r of t.reads) {
      const k = r.reader;
      const e = byReader.get(k) ?? { n: 0, first: r.at, last: r.at, via: new Set<string>() };
      e.n++;
      e.last = r.at;
      e.via.add(r.session_id ? `session start ${r.session_id}` : r.via);
      byReader.set(k, e);
    }
    for (const [who, e] of byReader) out.push(`  - ${p(who, 60)}: ${e.n} time(s), ${e.first}${e.n > 1 ? ` to ${e.last}` : ""} (${[...e.via].slice(0, 3).map((v) => p(v, 40)).join(", ")})`);
  }
  const line = (n: { id: number; namespace: string; title: string }): string => `note #${n.id} [${p(n.namespace, 40)}] "${p(n.title)}"`;
  const proven = t.built_on.filter((n) => n.basis === "proven");
  const likely = t.built_on.filter((n) => n.basis === "likely");
  if (proven.length) out.push("Built on it (proven: the app said so when it saved them):", ...proven.map((n) => `  - ${line(n)}${n.task ? " (task)" : ""}: ${p(n.why, 120)}`));
  if (likely.length) out.push(`Written after reading it (likely: same writer, within ${t.window_hours}h; check by hand):`, ...likely.map((n) => `  - ${line(n)}${n.task ? " (task)" : ""}: ${p(n.why, 120)}`));
  if (t.claimed_tasks.length) out.push("Tasks claimed after reading it (likely):", ...t.claimed_tasks.map((c) => `  - ${line(c)}: ${p(c.why, 120)}`));
  if (t.replaced.length) out.push("Notes it replaced (proven: replacement log):", ...t.replaced.map((r) => `  - ${line(r)}, replaced by ${p(r.by || "unknown", 60)}`));
  if (!proven.length && !likely.length && !t.claimed_tasks.length && !t.replaced.length) out.push("Nothing recorded was built on it.");
  if (t.hidden) out.push(`${t.hidden} more note(s) you cannot see here are not listed.`);
  out.push(t.not_recorded);
  return out.join("\n");
}
