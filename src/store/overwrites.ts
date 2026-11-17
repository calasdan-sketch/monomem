// r2-improvement #3: overwrites are never silent. The note history already records, for every replaced text, who wrote it
// (written_by) and who replaced it (saved_by), so "another writer replaced your text" is a read of note_history: no new table.
// Free function over the Store.

import type { Store } from "../store.js";
import { heldFromSessionStart } from "../taint.js";

export interface Overwrite {
  id: number;
  /** "" when the note is held (outside content, flagged...): a held note's title never reaches an agent this way. */
  title: string;
  /** Held from session start (heldFromSessionStart): the title is left out. */
  held?: true;
  /** The writer who replaced the text. */
  by: string;
  at: string;
}

/**
 * Notes whose text `writer` wrote and a DIFFERENT writer replaced (an ordinary edit, not a restore or rollback) since `sinceIso`,
 * newest first, one line per note. Only notes the caller can see now (readVisible: namespaces, ceiling, distrust list).
 */
export function overwritesOf(s: Store, writer: string, sinceIso: string, namespaces?: string[], limit = 10): Overwrite[] {
  if (!writer || (namespaces && namespaces.length === 0)) return [];
  const rows = s.db
    .prepare(
      `SELECT note_id, saved_by, MAX(saved_at) AS at FROM note_history
        WHERE written_by = ? AND saved_by <> ? AND saved_by <> '' AND reason = 'update' AND saved_at >= ?
        GROUP BY note_id, saved_by ORDER BY at DESC LIMIT ?`
    )
    .all(writer, writer, sinceIso, limit * 4) as Array<{ note_id: number; saved_by: string; at: string }>;
  const out: Overwrite[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const id = Number(r.note_id);
    if (seen.has(id)) continue;
    const n = s.readVisible(id, { hideArchived: true });
    if (!n || (namespaces && !namespaces.includes(n.namespace))) continue;
    seen.add(id);
    const enforce = typeof s.confirmSettings === "function" && s.confirmSettings().mode === "enforce";
    out.push(heldFromSessionStart(n, enforce) ? { id, title: "", held: true, by: r.saved_by, at: r.at } : { id, title: n.title, by: r.saved_by, at: r.at });
    if (out.length >= limit) break;
  }
  return out;
}
