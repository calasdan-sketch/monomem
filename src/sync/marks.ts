// File-sync helpers for the big release (A8 + device sync):
//
// 1. Tombstones. A note this store archived (forgot) or hard-deleted keeps its file in the sync folder, with two extra
//    front-matter keys at the end: `archived_at` and `archived_by` (the store id that forgot it). The body and the content
//    hash stay the same, so a 1.5 peer (which ignores unknown keys) never sees an edit and never blanks its live copy. A
//    hard delete is the exception: its body is blanked (the person took that text out on purpose), which peers apply as an edit. A
//    newer peer applies the marker as an archive, never a delete. Which markers this store already acted on is kept in
//    _meta (`sync_marks`), so a local restore is not undone by the next sync, and a marker that disappears (the forgetting
//    computer restored the note) brings the note back here too.
// 2. Machine labels. Each computer writes `.machines/<store id>.txt` (one line: its label) into the sync folder; every
//    other computer remembers it per store id, and shows it on notes that came from there (`monomem show`, `monomem why`).
//    Per store, not per note, so a 1.5 peer rewriting note files never strips it (no churn with mixed versions).

import type { Store } from "../store.js";
import { printable } from "../security.js";
import { contentHash } from "../sync-hash.js";

export interface Marker {
  at: string;
  by: string;
}

/** The archive marker a file carries, or null. Both keys must be there and sane (a file is untrusted input). */
export function markerOf(fm: Record<string, unknown>): Marker | null {
  const at = fm.archived_at;
  const by = fm.archived_by;
  if (typeof at !== "string" || typeof by !== "string") return null;
  if (!at || at.length > 40 || Number.isNaN(Date.parse(at)) || !by || by.length > 100) return null;
  return { at, by };
}

export function markerLines(m: Marker): string[] {
  return [`archived_at: ${JSON.stringify(m.at)}`, `archived_by: ${JSON.stringify(m.by)}`];
}

/** Add the marker as the last front-matter lines of a file we wrote (`---\n...\n---\n<body>`). Null if no front-matter. */
export function addMarker(text: string, m: Marker): string | null {
  const t = text.replace(/\r\n/g, "\n");
  if (!t.startsWith("---\n")) return null;
  const end = t.indexOf("\n---\n", 3);
  if (end < 0) return null;
  return `${t.slice(0, end)}\n${markerLines(m).join("\n")}${t.slice(end)}`;
}

/** Local note id -> the marker this store already acted on, and whether acting on it archived the note here. */
export type Handled = Map<number, { at: string; applied: boolean }>;
const MARKS_KEY = "sync_marks";

export function readHandled(store: Store): Handled {
  try {
    const raw = JSON.parse(store.getMeta(MARKS_KEY) ?? "{}") as Record<string, { at?: unknown; applied?: unknown }>;
    const out: Handled = new Map();
    for (const [k, v] of Object.entries(raw)) {
      if (/^\d+$/.test(k) && typeof v?.at === "string") out.set(Number(k), { at: v.at, applied: v.applied === true });
    }
    return out;
  } catch {
    return new Map(); // damaged: worst case a marker is applied once more (an archive, never a delete)
  }
}

export function writeHandled(store: Store, h: Handled): void {
  store.setMeta(MARKS_KEY, JSON.stringify(Object.fromEntries([...h].sort((a, b) => a[0] - b[0]))));
}

// ---- machine labels -------------------------------------------------------------------------------------------------------

export const MACHINES_DIR = ".machines";
export const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_MAX = 40;

/** A label from a file or the command line: one printable line, at most 40 characters; null if nothing is left. */
export function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = printable(raw.trim().slice(0, LABEL_MAX), LABEL_MAX).trim();
  return s ? s : null;
}

/** This computer's label. Default is neutral (`computer-` + 4 characters of the store id): a host name can be personal. */
export function machineLabel(store: Store): string {
  return cleanLabel(store.getMeta("machine_label")) ?? `computer-${store.storeId().slice(0, 4)}`;
}

export function setMachineLabel(store: Store, label: string): string {
  const l = cleanLabel(label);
  if (!l) throw new Error("the computer name is empty");
  store.setMeta("machine_label", l);
  return l;
}

/** The label of the computer (store) `origin`, if this store has heard it. */
export function machineOf(store: Store, origin: string): string | null {
  if (origin === store.storeId()) return machineLabel(store);
  return cleanLabel(store.getMeta(`sync_machine:${origin}`));
}

export function rememberMachine(store: Store, origin: string, label: string): void {
  if (!STORE_ID.test(origin) || origin === store.storeId()) return;
  const l = cleanLabel(label);
  if (l && store.getMeta(`sync_machine:${origin}`) !== l) store.setMeta(`sync_machine:${origin}`, l);
}

/** A note with `from_computer` added when it came in by file sync (MCP reads); unchanged otherwise. */
export function withComputer<T extends { id: number }>(store: Store, n: T): T & { from_computer?: string } {
  const pc = noteComputer(store, n.id);
  return pc ? { ...n, from_computer: pc } : n;
}

export function listWithComputer<T extends { notes: Array<{ id: number }> }>(store: Store, r: T): T {
  return { ...r, notes: r.notes.map((n) => withComputer(store, n)) };
}

/** For a note that came in by file sync: the computer it was first written on (its label, or a short store id). */
export function noteComputer(store: Store, localId: number): string | null {
  const origin = store.syncOriginOf(localId);
  if (!origin) return null;
  return machineOf(store, origin) ?? `computer ${origin.slice(0, 8)}`;
}

// ---- import: act on a marker ----------------------------------------------------------------------------------------------

export interface MarkerStep {
  id: number;
  /** The local note was archived before this file was merged, and its content hash then. */
  wasArchived: boolean;
  hashBefore: string;
  /** Content hash of the file, and its marker (null = none). */
  fileHash: string;
  marker: Marker | null;
  self: string;
  handled: Handled;
  archive: { archived: number; kept: number; restored: number; lines: string[] };
  rel: string;
}

/**
 * After a file was merged into local note `id`: apply its archive marker (archive here, never delete), or notice that a
 * marker went away / an archived note was edited on another computer (bring it back here, and say so).
 */
export function applyMarker(store: Store, st: MarkerStep): void {
  const now = store.read(st.id); // gate-ok: file sync is the local operator's path; nothing is returned to a caller
  if (!now) return;
  const h = st.handled.get(st.id);
  const same = contentHash(now) === st.fileHash;
  const m = st.marker;
  const kept = (why: string): void => {
    st.handled.set(st.id, { at: m!.at, applied: false });
    st.archive.kept++;
    st.archive.lines.push(`#${st.id} kept here: ${why}`);
  };
  if (m && m.by !== st.self) {
    if (h && h.at === m.at) return; // acted on before: a local restore since then stays
    const where = machineOf(store, m.by) ?? "another computer";
    if (now.archived_at) return void st.handled.set(st.id, { at: m.at, applied: false });
    if (!same) return kept(`edited here after it was archived on ${where}; the edit wins and will reach ${where}`);
    if (now.pinned) return kept(`archived on ${where}, but pinned here (\`monomem forget ${st.id}\` to match)`);
    if (store.isApproveFirst(now.namespace)) return kept(`archived on ${where}, but its namespace needs approval here (\`monomem forget ${st.id}\` to match)`);
    store.archive(st.id);
    st.handled.set(st.id, { at: m.at, applied: true });
    st.archive.archived++;
    st.archive.lines.push(`#${st.id} archived: it was archived on ${where} (\`monomem restore ${st.id}\` keeps it here)`);
    return;
  }
  if (m) return; // our own marker: export keeps or drops it
  // No marker in the file.
  if (h) {
    st.handled.delete(st.id);
    if (h.applied && now.archived_at && same && store.restore(st.id) !== null) {
      st.archive.restored++;
      st.archive.lines.push(`#${st.id} brought back: the other computer restored it`);
      return;
    }
  }
  if (st.wasArchived && now.archived_at && contentHash(now) !== st.hashBefore && store.restore(st.id) !== null) {
    st.archive.restored++;
    st.archive.lines.push(`#${st.id} brought back: it was archived here, but edited on another computer since`);
  }
}
