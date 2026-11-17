// Which notes each recorded read handed out (plan C23, "what did this bad note touch"). One row per note id in a read the
// access log counted: when, the server-stamped reader, and the tool or route. Ids and names only, never note text or titles.
// Kept on the access-log clock (MONOMEM_ACCESS_LOG_DAYS; 0 = nothing is recorded). A side table created on first use with
// CREATE TABLE IF NOT EXISTS (like receipts.ts), so SCHEMA_VERSION does not move and 1.5.0 still opens the database.
// Imports nothing at runtime from the store, so it sits in no import cycle (test/import-cycles.test.ts).
//
// Only an agent's reads are recorded: app keys and local apps (stdio, stdio:<app>). The owner's own reads are not: the main
// key the dashboard uses ("primary") and the person at the terminal (cli), so opening your own dashboard never shows up as
// a "proven read" of a note. Server-side markers (server, capture, runner, import:claude) are not readers either.
// One read is one multi-row INSERT (it used to be one statement, and one synced commit, per id: reads were 4-30x slower).
// Size: about 144 bytes per row with its two indexes (measured, round 4), so 200 ids, the cap per read, is about 29 KB;
// heavy use (about 43 MB per 30 days measured) is bounded by MONOMEM_ACCESS_LOG_DAYS.

import type { DatabaseSync } from "node:sqlite";
import { WRITER_MARKERS } from "../actor.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS note_reads (
  at TEXT NOT NULL,
  writer TEXT NOT NULL,
  tool TEXT NOT NULL,
  note_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_reads_note ON note_reads(note_id, at);
CREATE INDEX IF NOT EXISTS idx_note_reads_at ON note_reads(at);`;

/** Note ids recorded per read at most: a long list is still one read, and the table must not grow with page size. */
export const NOTE_READS_MAX_PER_READ = 200;
/** Tools and routes whose numeric ids are not note ids (held writes have their own ids). */
const NOT_NOTE_IDS = /quarantine|held/i;

const ready = new WeakSet<DatabaseSync>();
function ensure(db: DatabaseSync): void {
  if (ready.has(db)) return;
  db.exec(SCHEMA);
  ready.add(db);
}

/** Whether this reader's reads are recorded: an app key or a local app, not the owner (primary, cli) or a server marker. */
export function isAgentReader(writer: string): boolean {
  if (writer === "stdio" || writer.startsWith("stdio:")) return true;
  return writer !== "" && writer !== "primary" && !(WRITER_MARKERS as readonly string[]).includes(writer);
}

let failSaid = false;

/** Record the note ids one read handed out. Called inside Store.logAccess's best-effort write; never throws. */
export function recordNoteReads(db: DatabaseSync, at: string, writer: string, tool: string, ids: Iterable<number>): void {
  if (NOT_NOTE_IDS.test(tool) || !isAgentReader(writer)) return;
  const list = [...new Set(ids)].filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, NOTE_READS_MAX_PER_READ);
  if (!list.length) return;
  try {
    ensure(db);
    db.prepare("INSERT INTO note_reads (at, writer, tool, note_id) SELECT ?, ?, ?, value FROM json_each(?)").run(at, writer, tool, JSON.stringify(list));
  } catch (e) {
    // The read and its access-log row stand; only "what did this note touch" misses this read. Said once per process.
    if (failSaid) return;
    failSaid = true;
    process.stderr.write(`[monomem] could not record which notes a read handed out (${(e as Error).message}); "what did this touch" may miss reads. Shown once.
`);
  }
}

/** Drop rows older than `cutoff` (ISO). Runs with the access-log sweep. */
export function purgeNoteReads(db: DatabaseSync, cutoff: string): void {
  ensure(db);
  db.prepare("DELETE FROM note_reads WHERE at < ?").run(cutoff);
}

export interface NoteRead {
  at: string;
  writer: string;
  tool: string;
}

/** Every recorded read of one note, oldest first. */
export function readsOf(db: DatabaseSync, noteId: number): NoteRead[] {
  ensure(db);
  return db.prepare("SELECT at, writer, tool FROM note_reads WHERE note_id = ? ORDER BY at, rowid").all(noteId) as unknown as NoteRead[];
}
