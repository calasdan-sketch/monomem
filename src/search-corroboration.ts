// Independent-source signal (R6). Several near-identical notes are only agreement when different, trusted writers wrote them
// independently. Copies from one writer, one capture session, or notes built from each other (derived_from, merged_from_writers)
// are ONE source. Writers on probation, unknown writers and unverified imports count for little or nothing, and the rank lift is
// small (CORROBORATION_CAP), never lifts a note that is distrusted/unconfirmed/new-writer, and never passes a person-confirmed note.
// Ranks and labels only: no hit is ever dropped. Reads existing columns and the probation table (no schema change).
import type { Store, NoteRecord } from "./store.js";
import { nearCopy, wordSet } from "./search-diversity.js";

/** Lift per full-weight independent source beyond the first, and the most any note can gain (a flooder gets at most this). */
export const CORROBORATION_STEP = 0.04;
export const CORROBORATION_CAP = 0.1;
/** A writer the probation table has never seen counts half; a writer still on probation counts its age in days over FULL_TRUST_DAYS. */
const UNKNOWN_WRITER_WEIGHT = 0.5;
const FULL_TRUST_DAYS = 7;
const MIN_WORDS = 6;

export interface Corroboration { copies: number; independent_sources: number; label: string }
export type CorroboratedNote = NoteRecord & { corroboration?: Corroboration };
type Hit = { note: NoteRecord; score: number };

export function corroborationLabel(copies: number, sources: number): string {
  if (sources <= 1) return `${copies} copies are 1 source`;
  const others = sources - 1;
  return `confirmed by ${others} other independent ${others === 1 ? "writer" : "writers"}` + (copies > sources ? ` (${copies} copies, ${sources} sources)` : "");
}

/** Notes that must neither lend nor receive corroboration. */
function inert(n: NoteRecord): boolean {
  return !!(n.distrusted || n.unconfirmed || n.expired || n.new_writer || n.imported_unverified || n.superseded_by || n.archived_at);
}

const authors = (n: NoteRecord): string[] => [n.written_by, n.created_by, ...(n.merged_from_writers ?? [])].filter(Boolean);

/** Trust of each writer in [0,1]: "" and probation-young writers weigh ~0, unknown 0.5, established 1. */
function writerWeights(store: Store, writers: string[]): Map<string, number> {
  let rows = new Map<string, { first_seen_at: string; state: string }>();
  try {
    const all = store.db.prepare("SELECT writer, first_seen_at, state FROM writer_probation").all() as Array<{ writer: string; first_seen_at: string; state: string }>;
    rows = new Map(all.map((r) => [r.writer, r]));
  } catch { /* table not made yet (no write since upgrade): every writer is "unknown" */ }
  const out = new Map<string, number>();
  for (const w of writers) {
    const r = rows.get(w);
    const age = r ? (Date.now() - Date.parse(r.first_seen_at)) / 86_400_000 : 0;
    out.set(w, !w ? 0 : !r ? UNKNOWN_WRITER_WEIGHT : r.state === "probation" ? Math.min(1, Math.max(0, age) / FULL_TRUST_DAYS) : 1);
  }
  return out;
}

const find = (p: Map<number, number>, x: number): number => {
  let r = x;
  while (p.get(r) !== r) r = p.get(r)!;
  p.set(x, r);
  return r;
};

/** Group near-copies (text overlap >= DUP_JACCARD, or linked by derived_from) in score order; the first of a group is its head. */
function groupCopies(hits: Hit[]): NoteRecord[][] {
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const groups: Array<{ words: Set<string>; notes: NoteRecord[] }> = [];
  for (const h of sorted) {
    const w = wordSet(h.note);
    const linked = (g: { notes: NoteRecord[] }): boolean =>
      g.notes.some((m) => (h.note.derived_from ?? []).includes(m.id) || (m.derived_from ?? []).includes(h.note.id));
    const g = groups.find((x) => linked(x) || (w.size >= MIN_WORDS && x.words.size >= MIN_WORDS && nearCopy(w, x.words)));
    if (g) g.notes.push(h.note);
    else groups.push({ words: w, notes: [h.note] });
  }
  return groups.map((g) => g.notes).filter((g) => g.length > 1);
}

/** Merge a group's notes into sources: same writer (any authorship field), same capture session, or a derived_from link. */
function sourcesOf(group: NoteRecord[], weights: Map<string, number>): { count: number; othersWeight: number } {
  const parent = new Map<number, number>(group.map((n) => [n.id, n.id]));
  const union = (a: number, b: number): void => void parent.set(find(parent, a), find(parent, b));
  const owner = new Map<string, number>();
  const claim = (key: string, id: number): void => (owner.has(key) ? union(id, owner.get(key)!) : void owner.set(key, id));
  for (const n of group) {
    for (const w of [...authors(n), n.attested_writer ?? ""]) if (w) claim(`w:${w}`, n.id);
    if (n.session_id) claim(`s:${n.session_id}`, n.id);
    for (const d of n.derived_from ?? []) if (parent.has(d)) union(n.id, d);
  }
  const comp = new Map<number, number>(); // component root -> its best note weight
  for (const n of group) {
    // A note is as trustworthy as its LEAST trusted author, so a probation writer cannot be laundered through a merge.
    const ws = authors(n).map((w) => weights.get(w) ?? 0);
    const wt = inert(n) || ws.length === 0 ? 0 : Math.min(...ws);
    const root = find(parent, n.id);
    comp.set(root, Math.max(comp.get(root) ?? 0, wt));
  }
  const headRoot = find(parent, group[0].id);
  let count = 0;
  let others = 0;
  for (const [root, wt] of comp) {
    if (wt > 0) count++;
    if (root !== headRoot) others += wt;
  }
  return { count: Math.max(1, count), othersWeight: others };
}

const personConfirmed = (n: NoteRecord): boolean => (n.confirmed_kind === "human" || n.confirmed_kind === "admin") && n.confirmed_rev === n.rev;

/**
 * `hits` are the raw candidates (groups are found here, before near-duplicate damping); `scored` are the same hits with their
 * current scores. Returns `scored` with the head of each corroborated group lifted a little, plus the label for every member.
 */
export function corroborate(store: Store, hits: Hit[], scored: Hit[] = hits): { hits: Hit[]; info: Map<number, Corroboration> } {
  const info = new Map<number, Corroboration>();
  const groups = hits.length < 2 ? [] : groupCopies(hits);
  if (groups.length === 0) return { hits: scored, info };
  const weights = writerWeights(store, [...new Set(groups.flat().flatMap(authors))]);
  const lift = new Map<number, number>();
  for (const g of groups) {
    const { count, othersWeight } = sourcesOf(g, weights);
    const c = { copies: g.length, independent_sources: count, label: corroborationLabel(g.length, count) };
    for (const n of g) info.set(n.id, c);
    if (!inert(g[0])) lift.set(g[0].id, Math.min(CORROBORATION_CAP, CORROBORATION_STEP * othersWeight));
  }
  const confirmed = hits.filter((h) => personConfirmed(h.note)).map((h) => h.score);
  const out = scored.map((h) => {
    const l = lift.get(h.note.id) ?? 0;
    if (l <= 0) return h;
    const above = confirmed.filter((c) => c >= h.score);
    // Never past a person-confirmed note that was already ahead of it.
    const ceiling = above.length ? Math.min(...above) * (1 - 1e-9) : Infinity;
    return { ...h, score: Math.max(h.score, Math.min(h.score * (1 + l), ceiling)) };
  });
  return { hits: out, info };
}

/** Attach the label to the returned notes (a note outside any group keeps its exact shape). */
export const withCorroboration = (notes: NoteRecord[], info: Map<number, Corroboration>): CorroboratedNote[] =>
  info.size === 0 ? notes : notes.map((n) => (info.has(n.id) ? { ...n, corroboration: info.get(n.id)! } : n));
