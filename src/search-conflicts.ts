// Search side of `conflicts_with` links (conflict-detect.ts, store/conflict-links.ts). Before ranking: when an older hit has a
// recorded newer contradicting note, the older note's score is pulled just under the newer one's (both found), or the newer note is
// brought in just above it (only the older one matched: report 03 C1b, the newer note shares no query word). Nothing is dropped
// and nothing is deleted. Same guards as the restated-twin rule: the newer note must not be held, distrusted or replaced, and a
// note a person confirmed is not demoted by one nobody confirmed. A link recorded by one agent can reorder results and bring in at
// most ONE note per search, and only next to an older note that is itself a top-3 hit (security review F2: an unbounded lift let a
// linked note displace trusted ones). It never removes a note from the pool or deletes anything.
import type { NoteRecord, Store } from "./store.js";
import { linksAmong } from "./store/conflict-links.js";
import { heldFromSessionStart } from "./taint.js";

type Hit = { note: NoteRecord; score: number };
/** The older note goes this far under the newer one. */
export const CONFLICT_GAP = 0.98;
/** ... and only when the newer hit scores at least this share of the older one (a stray weak match does not bury a strong one). */
export const CONFLICT_MIN_SHARE = 0.3;
/** A note brought in from a link starts this far above the older one. */
export const CONFLICT_LIFT = 1.01;
/** At most this many notes are brought in from links per search, and only beside an older note ranked within the first INJECT_WITHIN. */
export const MAX_INJECTED = 1;
export const INJECT_WITHIN = 3;

const personConfirmed = (n: NoteRecord): boolean => (n.confirmed_kind === "human" || n.confirmed_kind === "admin") && n.confirmed_rev === n.rev;
const usable = (n: NoteRecord, enforce: boolean): boolean => !n.superseded_by && !n.archived_at && !n.distrusted && !heldFromSessionStart(n, enforce);

/** `inject`: false when the search is filtered (time range, writer, superseded), so a linked note is never added past the filter. */
export function applyConflicts(store: Store, hits: Hit[], inject: boolean): Hit[] {
  if (hits.length === 0 || (process.env.MONOMEM_CONFLICT_LINKS ?? "").trim() === "0") return hits;
  const links = linksAmong(store, hits.map((h) => h.note.id));
  if (links.length === 0) return hits;
  const enforce = typeof store.confirmSettings === "function" && store.confirmSettings().mode === "enforce";
  const score = new Map(hits.map((h) => [h.note.id, h.score]));
  const extra: Hit[] = [];
  for (const l of links) {
    const oldAt = hits.findIndex((h) => h.note.id === l.older);
    if (oldAt < 0) continue;
    const old = hits[oldAt];
    const mayInject = inject && l.kind !== "value" && extra.length < MAX_INJECTED && oldAt < INJECT_WITHIN;
    const newer = hits.find((h) => h.note.id === l.newer)?.note ?? (mayInject ? store.readVisible(l.newer) : null);
    if (!newer || !usable(newer, enforce) || (personConfirmed(old.note) && !personConfirmed(newer))) continue;
    const ns = score.get(l.newer);
    if (ns === undefined) {
      const lifted = (score.get(l.older) ?? 0) * CONFLICT_LIFT;
      score.set(l.newer, lifted);
      extra.push({ note: newer, score: lifted });
    } else if (ns >= CONFLICT_MIN_SHARE * (score.get(l.older) ?? 0)) {
      score.set(l.older, Math.min(score.get(l.older) ?? 0, ns * CONFLICT_GAP));
    }
  }
  return [...hits, ...extra].map((h) => ({ ...h, score: score.get(h.note.id) ?? h.score })).sort((a, b) => b.score - a.score);
}
