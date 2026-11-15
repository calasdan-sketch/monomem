// Writer reputation counts (R2-08, 1.5.0). What happened to each writer's writes over the last 30 days, recorded when it
// happens (writer_events): held by the linter, rejected by a person, rolled back, flagged and then replaced (flag upheld), and
// replaced by someone else through the two-step supersede. Visible only (`monomem trust`): nothing is held, hidden or ranked
// because of these numbers. They can only say something against a writer, never for it. Free functions over the Store; Store
// keeps a one-line delegate for each. Imports `type { Store }` only.

import type { Store } from "../store.js";

export type WriterEvent = "quarantined" | "rejected" | "rolled_back" | "flags_upheld" | "superseded";
export type WriterCounts = Record<WriterEvent, number>;
const EVENTS: readonly WriterEvent[] = ["quarantined", "rejected", "rolled_back", "flags_upheld", "superseded"];
export const REPUTATION_DAYS = 30;

/** Caller holds whatever transaction the event belongs to, so a rolled-back action records nothing. "" writers are not counted. */
export function recordWriterEvent(s: Store, writer: string, event: WriterEvent, noteId: number | null): void {
  if (!writer) return;
  s.db.prepare("INSERT INTO writer_events (writer, event, note_id, at) VALUES (?, ?, ?, ?)").run(writer, event, noteId, new Date().toISOString());
}

/** Per writer with at least one event in the window: every count (zeros included). */
export function writerReputation(s: Store, days = REPUTATION_DAYS): Record<string, WriterCounts> {
  const rows = s.db
    .prepare("SELECT writer, event, COUNT(*) AS c FROM writer_events WHERE at >= ? GROUP BY writer, event")
    .all(new Date(Date.now() - days * 86_400_000).toISOString()) as Array<{ writer: string; event: string; c: number }>;
  const out: Record<string, WriterCounts> = {};
  for (const r of rows) {
    if (!(EVENTS as readonly string[]).includes(r.event)) continue;
    out[r.writer] ??= { quarantined: 0, rejected: 0, rolled_back: 0, flags_upheld: 0, superseded: 0 };
    out[r.writer][r.event as WriterEvent] = Number(r.c);
  }
  return out;
}
