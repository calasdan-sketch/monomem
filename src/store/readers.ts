// Who read a note and when, from note_reads (written with each access_log row). Bounded; no note text, no query text.
// Only app and agent readers are recorded (the owner's own shell reads are not), and rows older than the access-log window
// are gone. Free function over the database handle.
import type { DatabaseSync } from "node:sqlite";

export const READERS_MAX = 50;
export const RECENT_MAX = 20;

export interface ReaderSummary { writer: string; reads: number; first_at: string; last_at: string; tools: string[] }
export interface Readers { readers: ReaderSummary[]; recent: Array<{ at: string; writer: string; tool: string }>; total_reads: number; truncated: boolean }

export function readersOf(db: DatabaseSync, noteId: number): Readers {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_reads'").get();
  if (!table || !Number.isSafeInteger(noteId)) return { readers: [], recent: [], total_reads: 0, truncated: false };
  const rows = db
    .prepare("SELECT writer, COUNT(*) AS reads, MIN(at) AS first_at, MAX(at) AS last_at, GROUP_CONCAT(DISTINCT tool) AS tools FROM note_reads WHERE note_id = ? GROUP BY writer ORDER BY last_at DESC LIMIT ?")
    .all(noteId, READERS_MAX + 1) as Array<{ writer: string; reads: number; first_at: string; last_at: string; tools: string | null }>;
  const recent = db.prepare("SELECT at, writer, tool FROM note_reads WHERE note_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(noteId, RECENT_MAX) as Array<{ at: string; writer: string; tool: string }>;
  const readers = rows.slice(0, READERS_MAX).map((r) => ({ writer: r.writer, reads: Number(r.reads), first_at: r.first_at, last_at: r.last_at, tools: (r.tools ?? "").split(",").filter(Boolean).slice(0, 10) }));
  return { readers, recent, total_reads: readers.reduce((s, r) => s + r.reads, 0), truncated: rows.length > READERS_MAX };
}
