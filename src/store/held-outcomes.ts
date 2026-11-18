// What became of a writer's held writes (1.6.1). A write the linter or approve-first held is answered at once ("held, nothing
// stored yet"), but the person decides later, and the writer was never told. This reads what is already recorded: the
// writer_events rows for an approval (held_approved, with the note it became) and a rejection (rejected). No new table, and
// nothing the held write said: ids, counts and dates only, so a rejected injected instruction never reaches the agent again.
// Free function over the Store.

import type { Store } from "../store.js";

export interface HeldOutcomes {
  /** Held writes a person approved: the note each became (only notes this reader may see now), newest first. */
  approved: Array<{ note_id: number; at: string }>;
  /** Held writes a person rejected (they were never stored). */
  rejected: number;
  /** When the newest rejection happened ("" when none). */
  rejected_at: string;
}

/** `writer`'s held writes decided since `sinceIso`. null when there is nothing to say. */
export function heldOutcomesOf(s: Store, writer: string, sinceIso: string, namespaces?: string[], limit = 5): HeldOutcomes | null {
  if (!writer || (namespaces && namespaces.length === 0)) return null;
  const rej = s.db
    .prepare("SELECT COUNT(*) AS c, MAX(at) AS at FROM writer_events WHERE writer = ? AND event = 'rejected' AND at >= ?")
    .get(writer, sinceIso) as { c: number; at: string | null };
  const rows = s.db
    .prepare("SELECT note_id, at FROM writer_events WHERE writer = ? AND event = 'held_approved' AND at >= ? AND note_id IS NOT NULL ORDER BY at DESC LIMIT ?")
    .all(writer, sinceIso, limit * 4) as Array<{ note_id: number; at: string }>;
  const approved: HeldOutcomes["approved"] = [];
  for (const r of rows) {
    const n = s.readVisible(Number(r.note_id), { hideArchived: true });
    if (!n || (namespaces && !namespaces.includes(n.namespace))) continue;
    approved.push({ note_id: Number(r.note_id), at: r.at });
    if (approved.length >= limit) break;
  }
  const rejected = Number(rej.c);
  return approved.length || rejected ? { approved, rejected, rejected_at: rej.at ?? "" } : null;
}

/** The one-line form for session start and the prompt step; "" when there is nothing to say. */
export function heldOutcomeText(o: HeldOutcomes | null): string {
  if (!o) return "";
  const parts: string[] = [];
  if (o.approved.length) parts.push(`${o.approved.length} approved (${o.approved.map((a) => "#" + a.note_id).join(", ")})`);
  if (o.rejected) parts.push(`${o.rejected} rejected and not stored (latest ${o.rejected_at.slice(0, 10)})`);
  return `A person decided writes of yours that were held for review: ${parts.join("; ")}. Do not assume a rejected note exists; save it again only if the user asks.`;
}
