// `monomem blame "<claim>"` and `monomem ask "<question>"`: two read-only views built from what Monomem already keeps. No model, no new data.
//   blame: the notes that match a claim, and for each one who wrote it, when, through how many versions, whether a person confirmed it,
//          whether it is held, replaced, disputed or backed by independent writers, and what changed it last.
//   ask:   a RETRIEVAL TIMELINE: the same search, grouped by topic, newest first, replaced notes marked. It is a list of what the notes
//          say, not a generated answer.
// Both go through runSearch (the one visibility path every read uses: namespace, sensitivity ceiling, distrust list, archive) and show
// titles only, through printable(). A held edit is shown as a count and only when the caller asked for it (admin); its text never is.
import { runSearch, roundRobin } from "./search-service.js";
import { printable } from "./security.js";
import { writerKind } from "./why.js";
import { linksAmong } from "./store/conflict-links.js";
import { withDisputes } from "./facts.js";
import { parseWindow } from "./audit-view.js";
import type { NoteRecord, Store } from "./store.js";

/** An ISO time or a window like 7d / 24h / 30m, as an ISO time; null when it is neither. */
export function sinceIso(s: string, now = Date.now()): string | null {
  const w = parseWindow(s);
  if (w !== null) return new Date(now - w).toISOString();
  return Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

export interface SearchScope {
  /** Namespaces the caller may read; undefined = all (the owner's shell). */
  namespaces?: string[];
  /** Replaced notes too (a management view: how a claim changed). */
  includeSuperseded: boolean;
  /** Notes by a distrusted writer too, marked (owner only). */
  includeDistrusted: boolean;
  /** Held edits are counted (admin only). */
  showHeld: boolean;
}

export interface BlameRow {
  id: number;
  namespace: string;
  title: string;
  state: "live" | "replaced" | "archived";
  replaced_by?: number | "another note";
  created_at: string;
  created_by: string;
  created_by_kind: string;
  written_by: string;
  updated_at: string;
  source: string;
  session_id: string;
  versions: number;
  versions_kept: number;
  confirmed_by_person: { by: string; at: string; how: string } | null;
  unconfirmed: string | null;
  held_edits?: number;
  distrusted_writer?: true;
  conflicts_with: Array<{ id: number; relation: "contradicts-older" | "contradicted-by-newer" }>;
  disputed: boolean;
  corroboration: string | null;
  last_change: { at: string; by: string; kind: string; reason: string } | null;
}

export interface Blame {
  rows: BlameRow[];
  note: string;
}

export const clampLimit = (n: number | undefined): number => Math.min(MAX_LIMIT, Math.max(1, Math.floor(n ?? DEFAULT_LIMIT)));

/** The notes a claim matches, by the keyword search (deterministic), over the caller's namespaces. */
export async function findNotes(store: Store, query: string, scope: SearchScope, limit: number): Promise<NoteRecord[]> {
  const opts = { limit, mode: "keyword" as const, ...(scope.includeSuperseded ? { includeSuperseded: true } : {}), ...(scope.includeDistrusted ? { includeDistrusted: true } : {}) };
  if (!scope.namespaces) return runSearch(store, query, opts);
  const lists: NoteRecord[][] = [];
  for (const ns of scope.namespaces) lists.push(await runSearch(store, query, { ...opts, namespace: ns }));
  return roundRobin(lists, limit);
}

const personConfirmed = (n: NoteRecord): boolean => (n.confirmed_kind === "human" || n.confirmed_kind === "admin") && n.confirmed_rev === n.rev;
const stateOf = (n: NoteRecord): BlameRow["state"] => (n.status === "superseded" || n.superseded_by != null ? "replaced" : n.archived_at ? "archived" : "live");

function lastChange(store: Store, n: NoteRecord): BlameRow["last_change"] {
  const log = store.captureDb().prepare("SELECT kind, changed_at, actor FROM change_log WHERE note_id = ? ORDER BY seq DESC LIMIT 1").get(n.id) as { kind: string; changed_at: string; actor: string } | undefined;
  if (!log) return null;
  const reason = n.rev > 1 ? (store.historyOf(n.id)[0]?.reason ?? "") : "";
  return { at: log.changed_at, by: printable(log.actor || n.written_by || "unknown", 100), kind: log.kind, reason: printable(reason, 120) };
}

/**
 * `shown`: the ids of the notes in this very answer. Another note's id is named only when it is one of them, so a link can never
 * name a note the search did not return to this caller (above its ceiling, another namespace, held, archived).
 */
export function blameRow(store: Store, raw: NoteRecord, shown: ReadonlySet<number>, showHeld = false): BlameRow {
  const n = withDisputes(store, raw);
  const links = linksAmong(store, [n.id]).flatMap((l) => {
    const other = l.newer === n.id ? l.older : l.newer;
    return shown.has(other) ? [{ id: other, relation: (l.newer === n.id ? "contradicts-older" : "contradicted-by-newer") as "contradicts-older" | "contradicted-by-newer" }] : [];
  });
  const creator = n.created_by || n.written_by;
  const claimed = !!n.imported_unverified || !!n.imported_written_by;
  const held = showHeld ? Number((store.captureDb().prepare("SELECT COUNT(*) AS c FROM quarantine WHERE target_id = ?").get(n.id) as { c: number }).c) : 0;
  const rep = n.superseded_by;
  return {
    id: n.id,
    namespace: printable(n.namespace, 80),
    title: printable(n.title, 120),
    state: stateOf(n),
    ...(rep != null ? { replaced_by: shown.has(rep) ? rep : ("another note" as const) } : {}),
    created_at: n.created_at,
    created_by: printable(creator, 100),
    created_by_kind: writerKind(creator, claimed),
    written_by: printable(n.written_by, 100),
    updated_at: n.updated_at,
    source: printable(n.source || "", 100),
    session_id: printable(n.session_id || "", 60),
    versions: n.rev,
    versions_kept: store.historyCount(n.id),
    confirmed_by_person: personConfirmed(n) ? { by: printable(n.confirmed_by || "", 100), at: n.confirmed_at ?? "", how: n.confirmed_kind ?? "" } : null,
    unconfirmed: n.unconfirmed ? printable(n.unconfirmed_label || "from outside, nobody confirmed it", 120) : null,
    ...(held ? { held_edits: held } : {}),
    ...(n.distrusted ? { distrusted_writer: true as const } : {}),
    conflicts_with: links,
    disputed: !!(n as { disputed?: unknown }).disputed,
    corroboration: (n as { corroboration?: { label: string } }).corroboration?.label ?? null,
    last_change: lastChange(store, n),
  };
}

export async function blame(store: Store, query: string, scope: SearchScope, limit = DEFAULT_LIMIT): Promise<Blame> {
  const notes = await findNotes(store, query, scope, clampLimit(limit));
  return {
    rows: notes.map((n) => blameRow(store, n, new Set(notes.map((x) => x.id)), scope.showHeld)),
    note: "Matched by keyword search over note titles and text; a match is a candidate, not proof the note says what you asked about. Nothing was changed. Undo a writer with monomem rollback --writer <label>.",
  };
}

const day = (iso: string): string => iso.slice(0, 10);
const stateWords = (r: BlameRow): string =>
  [
    r.state === "replaced" ? `replaced${r.replaced_by !== undefined ? ` by ${typeof r.replaced_by === "number" ? `#${r.replaced_by}` : r.replaced_by}` : ""}` : r.state,
    r.confirmed_by_person ? `confirmed by ${r.confirmed_by_person.by || "a person"}` : r.unconfirmed ? "unconfirmed" : "",
    r.held_edits ? `${r.held_edits} held edit${r.held_edits === 1 ? "" : "s"}` : "",
    r.distrusted_writer ? "writer distrusted" : "",
    r.conflicts_with.length ? `conflicts with ${r.conflicts_with.map((c) => `#${c.id}`).join(" ")}` : r.disputed ? "disputed" : "",
    r.corroboration ?? "",
  ]
    .filter(Boolean)
    .join("; ");

/** The compact table: one line per note, then what it is and is not. */
export function renderBlame(b: Blame, query: string): string {
  const q = printable(query, 200);
  if (!b.rows.length) return `No note matches "${q}". Nothing is recorded for it, so no writer can be named.`;
  const lines = [`Who wrote what matches "${q}" (in search rank order)`, "note | written | by | versions | last change | state"];
  for (const r of b.rows) {
    const lc = r.last_change ? `${day(r.last_change.at)} ${r.last_change.by}${r.last_change.reason ? ` (${r.last_change.reason})` : ""}` : "none recorded";
    const by = r.created_by === r.written_by ? r.created_by || "unknown" : `${r.created_by || "unknown"}, last ${r.written_by || "unknown"}`;
    lines.push(`#${r.id} ${r.title} | ${day(r.created_at)} | ${by}${r.source ? ` via ${r.source}` : ""}${r.session_id ? ` (session ${r.session_id})` : ""} | ${r.versions} (${r.versions_kept} kept) | ${lc} | ${stateWords(r)}`);
  }
  lines.push(b.note);
  return lines.join("\n");
}

// ---- ask: the retrieval timeline ------------------------------------------------------------------------------------------------

export interface TimelineLine {
  id: number;
  date: string;
  writer: string;
  title: string;
  state: string;
}
export interface TimelineGroup {
  topic: string;
  newest: string;
  lines: TimelineLine[];
}
export interface Timeline {
  kind: "retrieval-timeline";
  generated: false;
  groups: TimelineGroup[];
  note: string;
}
export const TIMELINE_NOTE =
  "This is a retrieval timeline, not a generated answer: no model wrote it. It lists notes that match your words by keyword search, grouped when one replaced or contradicts another. A note that does not share your words is not listed. Read one with monomem show <id>; its story is monomem why <id>.";

/** Notes tied together by a replacement or a recorded contradiction share a topic; nothing else is guessed. */
function groupRows(rows: BlameRow[]): BlameRow[][] {
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x: number): number => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const join = (a: number, b: number): void => {
    if (parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  };
  for (const r of rows) {
    if (typeof r.replaced_by === "number") join(r.id, r.replaced_by);
    for (const c of r.conflicts_with) join(r.id, c.id);
  }
  const by = new Map<number, BlameRow[]>();
  for (const r of rows) by.set(find(r.id), [...(by.get(find(r.id)) ?? []), r]);
  return [...by.values()];
}

const newestFirst = (a: BlameRow, b: BlameRow): number => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id);

export async function askTimeline(store: Store, query: string, scope: SearchScope, o: { since?: string; writer?: string; limit?: number } = {}): Promise<Timeline> {
  const notes = await findNotes(store, query, scope, clampLimit(o.limit ?? MAX_LIMIT));
  const sinceMs = o.since ? Date.parse(o.since) : NaN;
  const ids = new Set(notes.map((x) => x.id));
  let rows = notes.map((n) => blameRow(store, n, ids, scope.showHeld));
  if (Number.isFinite(sinceMs)) rows = rows.filter((r) => Date.parse(r.updated_at) >= sinceMs);
  if (o.writer) rows = rows.filter((r) => r.written_by === o.writer || r.created_by === o.writer);
  const groups: TimelineGroup[] = groupRows(rows).map((g) => {
    const sorted = [...g].sort(newestFirst);
    return { topic: sorted[0].title, newest: sorted[0].updated_at, lines: sorted.map((r) => ({ id: r.id, date: day(r.updated_at), writer: r.written_by || "unknown", title: r.title, state: stateWords(r) })) };
  });
  groups.sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0));
  return { kind: "retrieval-timeline", generated: false, groups, note: TIMELINE_NOTE };
}

export function renderTimeline(t: Timeline, query: string): string {
  const head = `Retrieval timeline for "${printable(query, 200)}" (keyword search, newest first; not a generated answer)`;
  if (!t.groups.length) return `${head}\nNo note matches. ${t.note}`;
  const lines = [head, "date | writer | title | state | id"];
  t.groups.forEach((g, i) => {
    if (t.groups.length > 1 || g.lines.length > 1) lines.push(`-- topic ${i + 1}: ${g.topic}${g.lines.length > 1 ? ` (${g.lines.length} notes)` : ""}`);
    for (const l of g.lines) lines.push(`${l.date} | ${l.writer} | ${l.title} | ${l.state} | #${l.id}`);
  });
  lines.push(t.note);
  return lines.join("\n");
}
