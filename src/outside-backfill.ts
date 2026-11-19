// One-off repair: stamp sessions.outside_at on ENDED sessions that have stored outside-tool results but no stamp, because they ran
// before the stamp existed. It uses the live rule exactly (capture.ts: a post-tool or post-tool-failure event with output from an
// outside tool) and takes MAX(at) over those events only.
//
// A person's `monomem settings outside-window clear` sets outside_at to NULL on an OPEN session; if that session later ends it looks
// exactly like a session that was never stamped. To never undo that decision, only sessions that STARTED BEFORE the earliest stamp still
// in the store are touched: they ran before stamping existed, so they cannot have been stamped and then cleared. (Limit: if the very
// earliest stamp was itself cleared, the cut-off moves later by that much, and a session in that gap could be stamped. The default
// outside-window is 12 hours, so the gap is small and it can only make the history stricter, never looser.) It also never touches an
// open session and only fills NULLs, so running it twice changes nothing.
import type { Store } from "./store.js";
import { isOutsideTool } from "./taint.js";
import { beginImmediate } from "./store/write-lock.js";

export interface BackfillRow {
  id: string;
  at: string;
}

export function findBackfill(store: Store): BackfillRow[] {
  const db = store.captureDb();
  const first = db.prepare("SELECT MIN(s.started_at) AS t FROM sessions s WHERE s.outside_at IS NOT NULL").get() as { t: string | null };
  if (!first.t) return []; // nothing was ever stamped here: there is no date before which a stamp could not exist
  const rows = db
    .prepare(
      `SELECT e.session_id AS id, e.tool AS tool, e.at AS at FROM capture_events e JOIN sessions s ON s.id = e.session_id
       WHERE s.ended_at IS NOT NULL AND s.outside_at IS NULL AND s.started_at < ? AND e.event IN ('post-tool', 'post-tool-failure')
         AND (e.output != '' OR e.output_enc IS NOT NULL) AND e.tool != ''`
    )
    .all(first.t) as Array<{ id: string; tool: string; at: string }>;
  const latest = new Map<string, string>();
  for (const r of rows) if (isOutsideTool(r.tool) && (latest.get(r.id) ?? "") < r.at) latest.set(r.id, r.at);
  return [...latest].map(([id, at]) => ({ id, at })).sort((a, b) => a.at.localeCompare(b.at));
}

/** Dry run unless `apply`. Re-checks inside the write transaction, so a session that changed meanwhile is skipped. */
export function backfillOutsideMarks(store: Store, apply: boolean): { found: BackfillRow[]; applied: number } {
  const found = findBackfill(store);
  if (!apply || !found.length) return { found, applied: 0 };
  const db = store.captureDb();
  beginImmediate(db);
  let applied = 0;
  try {
    const up = db.prepare("UPDATE sessions SET outside_at = ? WHERE id = ? AND outside_at IS NULL AND ended_at IS NOT NULL AND started_at < ?");
    const cut = (db.prepare("SELECT MIN(started_at) AS t FROM sessions WHERE outside_at IS NOT NULL").get() as { t: string | null }).t ?? "";
    for (const r of found) applied += Number(up.run(r.at, r.id, cut).changes ?? 0);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* nothing to roll back */
    }
    throw e;
  }
  return { found, applied };
}
