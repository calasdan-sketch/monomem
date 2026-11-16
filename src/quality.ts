// Memory quality view: one list of the things in the store worth a look, each with the command (or dashboard button)
// that fixes it through a path that already exists and already asks first.
//
//   duplicate    a group of near-identical notes, one entry per group however many copies (consolidate.ts candidates, joined)
//                                                                       fix: supersede preview+confirm (undo), or consolidate --dry-run then --yes
//   stale_twin   stale note with a newer, fresh neighbour (the pair search already demotes, search-service demoteStaleTwins)
//                                                                       fix: supersede preview+confirm (undo)
//   quarantined  write the linter held                                  fix: quarantine approve | reject
//   lint         live note the linter would flag today                  fix: archive (undo: restore)
//   decay        captured row the next decay sweep archives             fix: decay (undo: restore), or tag it "pinned"
//   pii          note that looks like it holds personal data (pattern)   fix: monomem label <id> private (a suggestion; nothing changes by itself)
//   contradiction two notes that may disagree (heuristic, English)       fix: supersede preview (undo available)
//   empty        live note with no body text (an agent guessed the wrong argument name, say)  fix: edit, or archive (undo: restore)
//   restated     its own writer wrote a newer note on the same subject but never retired this one (search labels it restated_by)
//                                                                       fix: supersede preview+confirm (undo)
//
// Read-only: building the report changes nothing. Admin surfaces only (CLI, GET /quality); it lists titles of every
// writer's notes, distrusted ones included.
import type { Store, NoteRecord } from "./store.js";
import { findCandidatesCooperative } from "./consolidate.js";
import { lintContent, describeFindings } from "./lint.js";
import { isStale, stalenessConfig } from "./staleness.js";
import { findConflicts, conflictReport, type Conflict, type ConflictGroup } from "./conflicts.js";
import { scanPii, describePii } from "./pii.js";
import { findContradictions } from "./contradiction.js";
import { factClash } from "./facts.js";
import { heldFromSessionStart } from "./taint.js";
import { RESTATE_MIN_SIM, expiryEnforced } from "./search-service.js";

export const QUALITY_TYPES = ["duplicate", "stale_twin", "quarantined", "lint", "decay", "pii", "contradiction", "empty", "restated"] as const;
export type QualityType = (typeof QUALITY_TYPES)[number];

export interface QualityIssue {
  type: QualityType;
  namespace: string;
  /**
   * The notes involved (for stale_twin / restated: [older, newer]). For duplicate: [an older copy, the copy to keep, ...the
   * other older copies], so ids[0]/ids[1] are always a valid "replace this with that" pair. Empty for a quarantined write.
   */
  ids: number[];
  /** For duplicate: the copy the fix keeps (the most recently updated). */
  keep_id?: number;
  /** For type quarantined: the quarantine id. */
  quarantine_id?: number;
  detail: string;
  /** The command that fixes it; every one previews or asks before it changes anything, and can be undone. */
  fix: string;
  /** Another way, when there is one. */
  alt?: string;
}

export interface QualityReport {
  counts: Record<QualityType, number>;
  issues: QualityIssue[];
  /** Possible conflicts between writers (conflicts.ts). Listed apart from `issues`: flag only, the human picks the fix. */
  conflicts: Conflict[];
  /** The same conflicts as one block per (namespace, key), listing every value and its notes. `conflict_total` counts blocks; `conflict_capped`: at least that many. */
  conflict_groups: ConflictGroup[];
  conflict_total: number;
  conflict_capped: boolean;
}

const PER_TYPE = 200; // ponytail: fixed cap per issue type, add paging if a store really has more to review
const quote = (s: string): string => JSON.stringify(s.length > 80 ? s.slice(0, 80) + "…" : s);

/** namespaces: undefined = the whole store. */
export async function qualityReport(store: Store, namespaces?: string[]): Promise<QualityReport> {
  const inScope = (ns: string): boolean => !namespaces || namespaces.includes(ns);
  const notes = store.exportAll({ live: true }).filter((n) => inScope(n.namespace)); // gate-ok: admin-only report
  const byId = new Map(notes.map((n) => [n.id, n]));
  const issues: QualityIssue[] = [];
  const pairKey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const seen = new Set<string>();

  for (const g of duplicateGroups(await findCandidatesCooperative(notes, { threshold: 0.95 })).slice(0, PER_TYPE)) {
    // Newest last: it is the one that stays.
    const sorted = g.ids.map((id) => byId.get(id)!).sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id - b.id);
    const keep = sorted[sorted.length - 1];
    const olds = sorted.slice(0, -1);
    for (const a of sorted) for (const b of sorted) if (a.id < b.id) seen.add(pairKey(a.id, b.id));
    issues.push({
      type: "duplicate",
      namespace: keep.namespace,
      ids: [olds[0].id, keep.id, ...olds.slice(1).map((o) => o.id)],
      keep_id: keep.id,
      detail: `${sorted.length} notes say the same thing: ${sorted.map((n) => `#${n.id} ${quote(n.title)}`).join(", ")} (score ${g.minScore.toFixed(3)} or higher); keep #${keep.id}, the newest`,
      fix: `monomem supersede --old ${olds.map((o) => o.id).join(",")} --new-id ${keep.id}`,
      alt: `monomem consolidate --namespace ${keep.namespace} --dry-run`,
    });
  }

  const cfg = stalenessConfig();
  let twins = 0;
  for (const n of notes) {
    if (twins >= PER_TYPE) break;
    if (!isStale(n, cfg).stale) continue;
    for (const id of store.neighbourIds(n.id)) {
      const fresh = byId.get(id);
      if (!fresh || isStale(fresh, cfg).stale || Date.parse(fresh.updated_at) <= Date.parse(n.updated_at)) continue;
      if (seen.has(pairKey(n.id, fresh.id))) continue;
      seen.add(pairKey(n.id, fresh.id));
      twins++;
      issues.push({
        type: "stale_twin",
        namespace: n.namespace,
        ids: [n.id, fresh.id],
        detail: `#${n.id} ${quote(n.title)} is stale and #${fresh.id} ${quote(fresh.title)} is a newer note on the same subject: check whether it replaces it`,
        fix: `monomem supersede --old ${n.id} --new-id ${fresh.id}`,
      });
      break;
    }
  }

  for (const q of store.listQuarantine({ namespaces, limit: PER_TYPE })) {
    issues.push({
      type: "quarantined",
      namespace: q.namespace,
      ids: [],
      quarantine_id: q.id,
      detail: `${q.op === "update" ? `update of #${q.target_id}` : "new note"} ${quote(q.title ?? "(title unchanged)")} held: ${describeFindings(q.reasons)}`,
      fix: `monomem quarantine approve ${q.id}`,
      alt: `monomem quarantine reject ${q.id}`,
    });
  }

  let linted = 0;
  for (const n of notes) {
    if (linted >= PER_TYPE) break;
    const found = lintContent({ title: n.title, body: n.body, tags: n.tags });
    if (!found.length) continue;
    linted++;
    issues.push({
      type: "lint",
      namespace: n.namespace,
      ids: [n.id],
      detail: `#${n.id} ${quote(n.title)}: ${describeFindings(found)}`,
      fix: `monomem archive ${n.id}`,
      alt: `monomem restore ${n.id}`,
    });
  }

  for (const d of store.decayCandidates(Date.now(), namespaces, PER_TYPE)) {
    issues.push({
      type: "decay",
      namespace: d.namespace,
      ids: [d.id],
      detail: `${d.obs_type || d.kind} #${d.id} ${quote(d.title)} not updated or read for ${d.idleDays} days`,
      fix: `monomem decay${namespaces?.length === 1 ? ` --namespace ${namespaces[0]}` : ""}`,
      alt: `add the tag "pinned" to keep it`,
    });
  }

  for (const p of scanPii(notes, PER_TYPE).suggestions) {
    issues.push({
      type: "pii",
      namespace: p.namespace,
      ids: [p.id],
      detail: describePii(p),
      fix: `monomem label ${p.id} private`,
      alt: "if it is not personal data, ignore this (the scan is pattern-based and can be wrong)",
    });
  }

  const byIdAll = new Map(notes.map((n) => [n.id, n]));
  for (const c of findContradictions(notes, { max: PER_TYPE }).found) {
    issues.push({
      type: "contradiction",
      namespace: c.namespace,
      ids: c.ids,
      detail: `#${c.ids[0]} and #${c.ids[1]} may contradict each other: ${c.why}`,
      fix: `monomem supersede --old ${c.ids[0]} --new-id ${c.ids[1]}`,
      alt: byIdAll.has(c.ids[0]) ? "this only previews and asks first; if both are right, ignore it" : undefined,
    });
  }

  let empties = 0;
  for (const n of notes) {
    if (empties >= PER_TYPE) break;
    if ((n.kind ?? "note") !== "note" || n.body.trim() !== "") continue;
    empties++;
    issues.push({
      type: "empty",
      namespace: n.namespace,
      ids: [n.id],
      detail: `#${n.id} ${quote(n.title)} has no text, only a title: the writer may have meant to save more`,
      fix: `monomem edit ${n.id}`,
      alt: `monomem archive ${n.id}  (undo: monomem restore ${n.id})`,
    });
  }

  let restated = 0;
  for (const [o, n] of restatedPairs(store, notes)) {
    if (restated >= PER_TYPE) break;
    if (seen.has(pairKey(o.id, n.id))) continue;
    seen.add(pairKey(o.id, n.id));
    restated++;
    issues.push({
      type: "restated",
      namespace: o.namespace,
      ids: [o.id, n.id],
      detail: `#${o.id} ${quote(o.title)} was restated by its own writer in #${n.id} ${quote(n.title)} but never retired, so both stay in search`,
      fix: `monomem supersede --old ${o.id} --new-id ${n.id}`,
      alt: "if both are still true, ignore this (search already shows the newer one first)",
    });
  }

  const counts = Object.fromEntries(QUALITY_TYPES.map((t) => [t, issues.filter((i) => i.type === t).length])) as Record<QualityType, number>;
  const pairs = findConflicts(store, { namespaces, notes });
  const grouped = conflictReport(pairs, PER_TYPE);
  return { counts, issues, conflicts: pairs.slice(0, PER_TYPE), conflict_groups: grouped.groups, conflict_total: grouped.total, conflict_capped: grouped.capped };
}

/** Near-duplicate pairs joined into groups (union-find): 4 copies give one group, not 6 pairs. */
export function duplicateGroups(pairs: ReadonlyArray<{ idA: number; idB: number; score: number }>): Array<{ ids: number[]; minScore: number }> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    return r;
  };
  const low = new Map<number, number>();
  for (const p of pairs) {
    const a = find(p.idA);
    const b = find(p.idB);
    const root = Math.min(a, b);
    parent.set(a, root);
    parent.set(b, root);
    low.set(root, Math.min(low.get(a) ?? 1, low.get(b) ?? 1, p.score));
  }
  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  return [...groups.entries()]
    .map(([r, ids]) => ({ ids: ids.sort((x, y) => x - y), minScore: low.get(r) ?? 1 }))
    .sort((x, y) => x.ids[0] - y.ids[0]);
}

const personConfirmed = (n: NoteRecord): boolean => (n.confirmed_kind === "human" || n.confirmed_kind === "admin") && n.confirmed_rev === n.rev;
const sameWriter = (a: NoteRecord, b: NoteRecord): boolean => a.written_by === b.written_by && (a.writer_id ?? "") === (b.writer_id ?? "");

/**
 * Search's restated-twin rule (search-service.ts demoteTwins) across the whole store, without its score parts: an older plain
 * note O and a newer plain note N in one namespace, by the SAME server-stamped writer, N written after O last changed, on the
 * same subject (a fact key with another value, or a similarity link >= RESTATE_MIN_SIM); N not replaced, distrusted or held;
 * O not confirmed by a person unless N is too. One pair per O: the newest such N.
 */
export function restatedPairs(store: Store, notes: NoteRecord[]): Array<[NoteRecord, NoteRecord]> {
  const enforce = expiryEnforced(store);
  const plain = notes.filter((n) => (n.kind ?? "note") === "note" && !n.superseded_by);
  const byNs = new Map<string, NoteRecord[]>();
  for (const n of plain) byNs.set(n.namespace, [...(byNs.get(n.namespace) ?? []), n]);
  const out: Array<[NoteRecord, NoteRecord]> = [];
  for (const o of plain) {
    let best: NoteRecord | undefined;
    let sims: Map<number, number> | undefined; // read only when a cheap candidate exists
    for (const n of byNs.get(o.namespace)!) {
      if (n.id === o.id || !sameWriter(n, o) || !(Date.parse(n.created_at) > Date.parse(o.updated_at))) continue;
      if (n.distrusted || heldFromSessionStart(n, enforce) || (personConfirmed(o) && !personConfirmed(n))) continue;
      if (best && Date.parse(n.created_at) <= Date.parse(best.created_at)) continue;
      const sameSubject = factClash(o.tags ?? [], n.tags ?? []) || ((sims ??= store.neighbourScores(o.id)).get(n.id) ?? 0) >= RESTATE_MIN_SIM;
      if (sameSubject && !(typeof store.isDistrusted === "function" && store.isDistrusted(n))) best = n;
    }
    if (best) out.push([o, best]);
  }
  return out;
}
