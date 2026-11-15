// "This looks wrong" flags (R2-02, 1.5.0). An agent flags a note instead of overwriting it; the note itself never changes. A
// flag names the version (rev) it was about and counts only while the note is still at that version and nobody kept it.
// Flags by the note's own writer are refused, and flags by a writer on the distrust list are ignored when read (the list can
// change after the flag). A flag by any other writer takes a note no person confirmed out of session start; a note a person
// confirmed stays there, labelled (a poisoned agent must not be able to erase confirmed memory). The reason is agent text:
// shown on reads (through the untrusted wrapper), never at session start, sealed at rest when encryption is on.
// Free functions over the Store; Store keeps a one-line delegate for each. Imports `type { Store }` only.

import type { NoteRecord, NoteRow, Store } from "../store.js";
import { currentWriter } from "../actor.js";
import { ValidationError } from "../errors.js";
import { printable } from "../security.js";
import { matchesDistrust } from "../trust.js";
import { ENC_PREFIX_V3, decryptV3, encryptV3 } from "../crypto.js";

export const MAX_FLAG_REASON = 200;
export const MAX_FLAGS_PER_DAY = 20;
const DAY_MS = 86_400_000;

/** One flag as a reader sees it. */
export interface NoteFlag { by: string; reason: string; at: string }
/** One row of the flagged list (`monomem review`). */
export interface FlaggedItem { id: number; namespace: string; title: string; writer: string; flags: NoteFlag[] }

const flagAad = (noteId: number, flagId: number): string => `flag|${noteId}|${flagId}`;

/** note_flags only ever gains rows: once it has one it always will. An empty answer is re-asked at most once a second. */
const seen = new WeakMap<Store, { any: boolean; at: number }>();
function anyFlags(s: Store): boolean {
  const c = seen.get(s);
  if (c && (c.any || Date.now() - c.at < 1000)) return c.any;
  const any = s.db.prepare("SELECT 1 FROM note_flags LIMIT 1").get() !== undefined;
  seen.set(s, { any, at: Date.now() });
  return any;
}

export function flagNote(s: Store, id: number, reason: unknown): { note_id: number; rev: number; at: string } | null {
  // Visibility first: a reason error on a hidden note would tell it apart from a missing id (final-security SF1).
  const n = s.readVisible(id, { hideArchived: true });
  if (!n) return null;
  const why = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (!why) throw new ValidationError("reason is required: say in one line what looks wrong");
  if (why.length > MAX_FLAG_REASON) throw new ValidationError(`reason is at most ${MAX_FLAG_REASON} characters`);
  const w = currentWriter();
  if (w !== "" && n.written_by === w) throw new ValidationError("this is your own note: change it (state_write with its id) instead of flagging it");
  const at = new Date().toISOString();
  return s.transaction(() => {
    const today = Number((s.db.prepare("SELECT COUNT(*) AS c FROM note_flags WHERE flagged_by = ? AND at >= ?").get(w, new Date(Date.now() - DAY_MS).toISOString()) as { c: number }).c);
    if (today >= MAX_FLAGS_PER_DAY) throw new ValidationError(`at most ${MAX_FLAGS_PER_DAY} flags per writer per day; ask the user instead`);
    s.floodGate("full"); // a flag is a write: it counts toward the flood guard
    const fid = Number(s.db.prepare("INSERT INTO note_flags (note_id, note_rev, flagged_by, reason, at) VALUES (?, ?, ?, '', ?)").run(n.id, n.rev, w, at).lastInsertRowid);
    const key = s.writeKey();
    s.db.prepare("UPDATE note_flags SET reason = ? WHERE id = ?").run(key ? encryptV3(why, key, flagAad(n.id, fid)) : printable(why, MAX_FLAG_REASON), fid);
    seen.set(s, { any: true, at: Date.now() });
    s.audit({ op: "flag", id: n.id, namespace: n.namespace });
    return { note_id: n.id, rev: n.rev, at };
  });
}

/** The flags that count for this version of the note, oldest first: not cleared, not the writer's own, not a distrusted writer's. */
function activeFlags(s: Store, row: Pick<NoteRow, "id" | "rev" | "namespace" | "written_by">): NoteFlag[] {
  if (!anyFlags(s)) return [];
  const rows = s.db
    .prepare("SELECT id, flagged_by, reason, at FROM note_flags WHERE note_id = ? AND note_rev = ? AND cleared_at IS NULL ORDER BY id")
    .all(row.id, row.rev) as Array<{ id: number; flagged_by: string; reason: string; at: string }>;
  if (!rows.length) return [];
  const rules = s.distrustRules();
  const sid = rules.length ? s.serverId() : "";
  return rows
    .filter((f) => f.flagged_by !== row.written_by && !(rules.length && matchesDistrust(rules, { namespace: row.namespace, written_by: f.flagged_by }, sid)))
    .map((f) => ({ by: f.flagged_by, reason: openReason(s, f.reason, Number(row.id), Number(f.id)), at: f.at }));
}

function openReason(s: Store, v: string, noteId: number, flagId: number): string {
  if (!v.startsWith(ENC_PREFIX_V3)) return v;
  try {
    return decryptV3(v, s.readKey(), flagAad(noteId, flagId));
  } catch {
    return "[reason sealed: the key is missing]";
  }
}

/** rec(): `flagged` and `flagged_label` on a note with active flags; other notes keep their exact shape. */
export function annotateFlags(s: Store, row: NoteRow, out: NoteRecord): NoteRecord {
  if (row.rev === undefined || row.archived_at) return out;
  const flags = activeFlags(s, row);
  if (!flags.length) return out;
  const names = [...new Set(flags.map((f) => printable(f.by, 60)))];
  out.flagged = flags;
  out.flagged_label = `[flagged by ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3}` : ""}]`;
  return out;
}

/** Live notes with active flags, for `monomem review` (newest flag first). */
export function flaggedList(s: Store, namespaces?: string[]): FlaggedItem[] {
  if (!anyFlags(s)) return [];
  const ids = (s.db
    .prepare(
      `SELECT n.id FROM notes n JOIN note_flags f ON f.note_id = n.id AND f.note_rev = n.rev AND f.cleared_at IS NULL
        WHERE n.archived_at IS NULL${namespaces ? ` AND n.namespace IN (${namespaces.map(() => "?").join(",")})` : ""}
        GROUP BY n.id ORDER BY max(f.id) DESC LIMIT 200`
    )
    .all(...(namespaces ?? [])) as Array<{ id: number }>).map((r) => Number(r.id));
  const out: FlaggedItem[] = [];
  for (const id of ids) {
    const n = s.readVisible(id, { hideArchived: true });
    if (n?.flagged) out.push({ id: n.id, namespace: n.namespace, title: n.title, writer: n.written_by, flags: n.flagged });
  }
  return out;
}

/** A person keeps the note as it is: the flags on its current version are cleared (they stay on record). Returns how many. */
export function keepFlagged(s: Store, id: number): number {
  const n = s.read(id); // gate-ok: operator action from the CLI; clears flags, returns a count only
  if (!n) return 0;
  const by = currentWriter() || "cli";
  const c = Number(s.db.prepare("UPDATE note_flags SET cleared_at = ?, cleared_by = ? WHERE note_id = ? AND note_rev = ? AND cleared_at IS NULL").run(new Date().toISOString(), by, id, n.rev).changes);
  if (c) s.audit({ op: "flag-keep", id, namespace: n.namespace });
  return c;
}
