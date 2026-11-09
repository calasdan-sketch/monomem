// Memory quality view: one list of the things in the store worth a look, each with the command (or dashboard button)
// that fixes it through a path that already exists and already asks first.
//
//   duplicate    near-duplicate pair (consolidate.ts candidates)        fix: supersede preview+confirm (undo), or consolidate --dry-run then --yes
//   stale_twin   stale note with a newer, fresh neighbour (the pair search already demotes, search-service demoteStaleTwins)
//                                                                       fix: supersede preview+confirm (undo)
//   quarantined  write the linter held                                  fix: quarantine approve | reject
//   lint         live note the linter would flag today                  fix: archive (undo: restore)
//   decay        captured row the next decay sweep archives             fix: decay (undo: restore), or tag it "pinned"
//   pii          note that looks like it holds personal data (pattern)   fix: monomem label <id> private (a suggestion; nothing changes by itself)
//   contradiction two notes that may disagree (heuristic, English)       fix: supersede preview (undo available)
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

export const QUALITY_TYPES = ["duplicate", "stale_twin", "quarantined", "lint", "decay", "pii", "contradiction"] as const;
export type QualityType = (typeof QUALITY_TYPES)[number];

export interface QualityIssue {
  type: QualityType;
  namespace: string;
  /** The notes involved (for duplicate / stale_twin: [older, newer]). Empty for a quarantined write. */
  ids: number[];
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
  // Older first: the newer note is the one that stays.
  const ordered = (a: NoteRecord, b: NoteRecord): [NoteRecord, NoteRecord] => (Date.parse(a.updated_at) <= Date.parse(b.updated_at) ? [a, b] : [b, a]);

  for (const c of (await findCandidatesCooperative(notes, { threshold: 0.95 })).slice(0, PER_TYPE)) {
    const [old, keep] = ordered(byId.get(c.idA)!, byId.get(c.idB)!);
    seen.add(pairKey(old.id, keep.id));
    issues.push({
      type: "duplicate",
      namespace: old.namespace,
      ids: [old.id, keep.id],
      detail: `#${old.id} ${quote(old.title)} and #${keep.id} ${quote(keep.title)} look the same (score ${c.score.toFixed(3)})`,
      fix: `monomem supersede --old ${old.id} --new-id ${keep.id}`,
      alt: `monomem consolidate --namespace ${old.namespace} --dry-run`,
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

  const counts = Object.fromEntries(QUALITY_TYPES.map((t) => [t, issues.filter((i) => i.type === t).length])) as Record<QualityType, number>;
  const pairs = findConflicts(store, { namespaces, notes });
  const grouped = conflictReport(pairs, PER_TYPE);
  return { counts, issues, conflicts: pairs.slice(0, PER_TYPE), conflict_groups: grouped.groups, conflict_total: grouped.total, conflict_capped: grouped.capped };
}
