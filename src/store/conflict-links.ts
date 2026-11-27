// `conflicts_with` links: newer note -> older note it contradicts (conflict-detect.ts). A side table created on first use
// (CREATE IF NOT EXISTS, no schema bump; older binaries ignore it). Links are advisory: search reorders by them and labels the
// older note; nothing is deleted. Not synced or restored: a missing link only means the old ranking.
import type { NoteRecord, Store } from "../store.js";
import { findConflictCandidates } from "../conflict-detect.js";

const T = "conflict_links";
const exists = (store: Store): boolean => store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(T) !== undefined;

export interface ConflictLink {
  newer: number;
  older: number;
  kind: string;
  why: string;
}

const made = new WeakSet<object>(); // stores whose link table this process has already created (no DDL per write)

/** Record links for a new note, in one savepoint (one commit, not one per link). Never throws: a failed record leaves the write untouched. */
export function recordConflictLinks(store: Store, newer: number, found: Array<{ id: number; kind: string; why: string }>): void {
  if (found.length === 0) return;
  try {
    if (!made.has(store)) {
      store.db.exec(`CREATE TABLE IF NOT EXISTS ${T}(newer INTEGER NOT NULL, older INTEGER NOT NULL, kind TEXT NOT NULL, why TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(newer, older))`);
      made.add(store);
    }
    const ins = store.db.prepare(`INSERT OR REPLACE INTO ${T}(newer, older, kind, why, at) VALUES (?, ?, ?, ?, ?)`);
    const at = new Date().toISOString();
    store.db.exec("SAVEPOINT monomem_conflict_links");
    try {
      for (const f of found) ins.run(newer, f.id, f.kind, f.why.slice(0, 200), at);
      store.db.exec("RELEASE monomem_conflict_links");
    } catch (e) {
      store.db.exec("ROLLBACK TO monomem_conflict_links");
      store.db.exec("RELEASE monomem_conflict_links");
      throw e;
    }
  } catch {
    made.delete(store);
    /* advisory only */
  }
}

/** Links with either end among `ids` (the notes of a result set). */
export function linksAmong(store: Store, ids: number[]): ConflictLink[] {
  if (ids.length === 0) return [];
  try {
    if (!exists(store)) return [];
    const q = ids.map(() => "?").join(",");
    return store.db.prepare(`SELECT newer, older, kind, why FROM ${T} WHERE older IN (${q}) OR newer IN (${q})`).all(...ids, ...ids) as unknown as ConflictLink[];
  } catch {
    return [];
  }
}

/** store.create's last step: find and record what the new note contradicts. Off with MONOMEM_CONFLICT_LINKS=0; never throws. */
export function afterCreate(store: Store, note: NoteRecord): void {
  if ((process.env.MONOMEM_CONFLICT_LINKS ?? "").trim() === "0" || store.sealsWrites()) return; // sealed bodies are not searched inside a write
  try {
    recordConflictLinks(store, note.id, findConflictCandidates(store, note));
  } catch {
    /* advisory only: the write already succeeded */
  }
}

/** The save reply's `conflicts_with` field: older notes the saved one contradicts (what to look at; nothing was changed). Visible notes only. */
export function conflictsField(store: Store, newerId: number): { conflicts_with?: Array<{ id: number; title: string; why: string; hint: string }> } {
  const out: Array<{ id: number; title: string; why: string; hint: string }> = [];
  for (const l of linksAmong(store, [newerId])) {
    if (l.newer !== newerId) continue;
    const o = store.readVisible(l.older);
    if (o && !o.archived_at && o.superseded_by == null) out.push({ id: o.id, title: o.title, why: l.why, hint: `may contradict #${o.id}; nothing was changed. If this one is current, retire the old one with memory_replace` });
  }
  return out.length ? { conflicts_with: out } : {};
}
