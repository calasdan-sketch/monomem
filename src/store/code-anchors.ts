// Code anchors (R2-03, 1.5.0): the files a note is about, each pinned to its git blob when the note was written. When the
// committed file changes, reads carry `code_changed` and a label, and the note joins `monomem review` (it is never hidden,
// deleted or unpinned for it). The git work is in ../code-anchor.ts; these are the table and the read annotation.
// Free functions over the Store; Store keeps a one-line delegate for each. Imports `type { Store }` only.

import type { NoteRecord, NoteRow, Store } from "../store.js";
import { actorStore, currentWriter } from "../actor.js";
import { printable } from "../security.js";
import { anchorsFor, changedAnchors, checkFilesInput, headBlobs, type CodeAnchor } from "../code-anchor.js";

/** One changed file as a reader sees it: the path and the commit the note was written against. */
export interface CodeChange { path: string; since_commit: string }
/** One row of `monomem stale --code` / review. */
export interface CodeChangedItem { id: number; namespace: string; title: string; writer: string; pinned: boolean; changed: CodeChange[] }

/** code_anchors only gains rows in normal use; an empty answer is re-asked at most once a second. */
const seen = new WeakMap<Store, { any: boolean; at: number }>();
function anyAnchors(s: Store): boolean {
  const c = seen.get(s);
  if (c && (c.any || Date.now() - c.at < 1000)) return c.any;
  const any = s.db.prepare("SELECT 1 FROM code_anchors LIMIT 1").get() !== undefined;
  seen.set(s, { any, at: Date.now() });
  return any;
}

/** The anchors for `files`, from the writer's folder (a local server's launch folder, else this process's). Git runs here, outside any transaction. */
export function prepareAnchors(files: string[] | undefined): CodeAnchor[] {
  const list = checkFilesInput(files);
  if (!list?.length) return [];
  return anchorsFor(list, actorStore.getStore()?.cwd ?? process.cwd());
}

/** Replace a note's anchors. Runs inside the caller's write transaction. */
export function setAnchors(s: Store, noteId: number, anchors: readonly CodeAnchor[], at: string): void {
  if (!anchors.length) return;
  s.db.prepare("DELETE FROM code_anchors WHERE note_id = ?").run(noteId);
  const ins = s.db.prepare("INSERT INTO code_anchors (note_id, path, blob, commit_sha, repo_root, at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const a of anchors) ins.run(noteId, a.path, a.blob, a.commit, a.root, at);
  seen.set(s, { any: true, at: Date.now() });
}

function anchorsOf(s: Store, noteId: number): CodeAnchor[] {
  return (s.db.prepare("SELECT path, blob, commit_sha, repo_root FROM code_anchors WHERE note_id = ? ORDER BY path").all(noteId) as Array<{ path: string; blob: string; commit_sha: string; repo_root: string }>).map(
    (r) => ({ path: r.path, blob: r.blob, commit: r.commit_sha, root: r.repo_root })
  );
}

/** rec(): `code_changed` and `code_changed_label` when a file the note is about changed in git since; other notes keep their shape. */
export function annotateCodeChanged(s: Store, row: NoteRow, out: NoteRecord): NoteRecord {
  if (row.archived_at || !anyAnchors(s)) return out;
  const anchors = anchorsOf(s, Number(row.id));
  if (!anchors.length) return out;
  const changed = changedAnchors(anchors);
  if (!changed.length) return out;
  out.code_changed = changed.map((a) => ({ path: printable(a.path, 200), since_commit: a.commit.slice(0, 12) }));
  // A file name cannot close the label and open a fake one: brackets become parentheses.
  const names = out.code_changed.map((c) => printable(c.path, 80).replace(/\[/g, "(").replace(/\]/g, ")"));
  out.code_changed_label = `[code changed since this was written: ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3}` : ""}]`;
  return out;
}

/** Live notes this caller may see whose anchored files changed, for `monomem stale --code` and `monomem review`. */
export function codeChangedList(s: Store, namespaces?: string[]): CodeChangedItem[] {
  if (!anyAnchors(s)) return [];
  const ids = (s.db
    .prepare(
      `SELECT DISTINCT n.id FROM notes n JOIN code_anchors a ON a.note_id = n.id
        WHERE n.archived_at IS NULL${namespaces ? ` AND n.namespace IN (${namespaces.map(() => "?").join(",")})` : ""} ORDER BY n.id DESC LIMIT 500`
    )
    .all(...(namespaces ?? [])) as Array<{ id: number }>).map((r) => Number(r.id));
  const out: CodeChangedItem[] = [];
  for (const id of ids) {
    const n = s.readVisible(id, { hideArchived: true });
    if (n?.code_changed) out.push({ id: n.id, namespace: n.namespace, title: n.title, writer: n.written_by, pinned: n.pinned === true, changed: n.code_changed });
  }
  return out;
}

/** A person says the note still holds: its anchors move to the files as they are at HEAD now. Returns how many moved. */
export function refreshAnchors(s: Store, id: number): number {
  const anchors = anchorsOf(s, id);
  const changed = changedAnchors(anchors);
  if (!changed.length) return 0;
  const at = new Date().toISOString();
  return s.transaction(() => {
    const upd = s.db.prepare("UPDATE code_anchors SET blob = ?, commit_sha = ?, at = ? WHERE note_id = ? AND path = ?");
    let moved = 0;
    for (const a of changed) {
      const t = headBlobs(a.root);
      if (!t) continue;
      // A file gone at HEAD keeps an empty blob: it stays "changed" only if it comes back different.
      moved += Number(upd.run(t.blobs.get(a.path) ?? "", t.head, at, id, a.path).changes);
    }
    if (moved) s.audit({ op: "code-anchor-keep", id, detail: currentWriter() || "cli" });
    return moved;
  });
}
