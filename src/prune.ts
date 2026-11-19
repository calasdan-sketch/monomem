// `monomem prune`: list (and, with --yes, archive) notes nobody has ever recalled, that are old, unpinned and low value.
// Never deletes: archive is the same soft archive the dashboard uses, and `monomem restore <id>` brings a note back.
// A note a person pinned or confirmed, a task, a handoff, or a decision, rule or fact (by kind, by tag, or by how it begins)
// is never a candidate and never archived, even when it is old, short and was never recalled.
import type { NoteRecord, Store } from "./store.js";
import { TASK_TAG } from "./task-core.js";
import { HANDOFF_TAG } from "./tasks.js";
import { NEVER_SHOW_TAG } from "./reserved-tags.js";

export interface PruneCandidate {
  id: number;
  title: string;
  namespace: string;
  age_days: number;
  why: string;
}

const DAY = 86_400_000;
const SCAN = 5000;

/** Why this note must stay, or "" when it may be a candidate. */
export function protectedReason(n: NoteRecord): string {
  if (n.pinned) return "pinned";
  if (n.confirmed_at || n.confirmed_kind) return "confirmed by a person";
  if ((n.access_count ?? 0) > 0 || n.last_accessed) return "recalled before";
  return "";
}

/** Tags (and tag prefixes such as `fact:key=value`) that mark a note as something to keep, whatever its size or age. */
const KEEP_TAGS = /^(?:decisions?|rules?|facts?|policy|policies|constraints?|requirements?|preferences?|conventions?|standing|always|never|must)(?:$|[:=\s/.-])/i;
/** A note whose own first words say it is one of those ("Decision: use pnpm"), even when nobody tagged it. */
const KEEP_LEAD = /^\s*(?:decision|rule|fact|policy|constraint|requirement|convention|standing\s+(?:rule|order|instruction))s?\b/i;

/** Why this note must stay because of what KIND of note it is, or "" (a decision, rule or fact is never low value, however short). */
export function protectedKind(n: NoteRecord): string {
  const kind = String(n.kind ?? "").toLowerCase();
  if (/^(?:decision|rule|fact)s?$/.test(kind)) return `a ${kind}`;
  const tag = (n.tags ?? []).find((t) => KEEP_TAGS.test(String(t).trim()));
  if (tag !== undefined) return `tagged ${String(tag).slice(0, 30)}`;
  if (KEEP_LEAD.test(n.title ?? "") || KEEP_LEAD.test(String(n.body ?? "").slice(0, 60))) return "reads like a decision, rule or fact";
  return "";
}

/** Low value: a plain observation or summary (not a decision, rule or fact), or a very short note. Never for a protected kind. */
function lowValue(n: NoteRecord): string {
  if (protectedKind(n)) return "";
  const kind = String(n.kind ?? "");
  if (kind === "observation" || kind === "summary") return `a ${kind}`;
  if (n.body.trim().length < 80) return "very short";
  return "";
}

export function pruneCandidates(store: Store, opts: { namespace?: string; days: number; now?: number }): PruneCandidate[] {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.days * DAY;
  const notes = store.list({ namespace: opts.namespace, limit: SCAN, count: false, withoutTags: [TASK_TAG, HANDOFF_TAG, NEVER_SHOW_TAG] }).notes;
  const out: PruneCandidate[] = [];
  for (const n of notes) {
    if (protectedReason(n)) continue;
    const updated = typeof n.updated_at === "number" ? n.updated_at : Date.parse(String(n.updated_at));
    if (!Number.isFinite(updated) || updated > cutoff) continue;
    const why = lowValue(n);
    if (!why) continue;
    out.push({ id: n.id, title: n.title, namespace: n.namespace, age_days: Math.floor((now - updated) / DAY), why: `never recalled, ${Math.floor((now - updated) / DAY)} days old, ${why}` });
  }
  return out.sort((a, b) => b.age_days - a.age_days);
}

/**
 * Archive each candidate (never delete). Returns the ids actually archived. Each note is read again first and checked
 * against the same protections: a note that was pinned, confirmed, recalled or tagged decision/rule/fact since the list was
 * made (or a candidate list built by someone else) is skipped.
 */
export function applyPrune(store: Store, cands: PruneCandidate[]): number[] {
  const done: number[] = [];
  for (const c of cands) {
    const n = store.read(c.id); // gate-ok: the owner's own command
    if (!n || protectedReason(n) || protectedKind(n)) continue;
    if (store.archive(c.id)) done.push(c.id);
  }
  return done;
}
