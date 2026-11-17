// The checks before an update by id, shared by REST PUT /notes/:id and MCP state_write (1.5.0 P-01). Both surfaces used to
// write them out separately, in different orders; MCP's order once let a reserved-tag refusal reveal a hidden note (A2).
// The order here: visibility first (a note the distrust list hides, a forgotten one, or a missing one is "missing"), then
// the namespace (a pinned caller may only change its own namespace's notes: a read grant never confers write access), then
// facts and the tag guards on the note the caller may see.
import type { NoteRecord, Store } from "./store.js";
import { assertPlainWriteTags, assertReviewedTag } from "./reserved-tags.js";
import { withFacts } from "./facts.js";
import { lineDiff } from "./line-diff.js";
import { printable } from "./security.js";

export type NoteUpdateCheck =
  | { ok: true; target: NoteRecord; tags: string[] | undefined }
  | { ok: false; why: "missing" | "other-namespace" };

export function prepareNoteUpdate(
  store: Store,
  c: {
    /** An admin may rewrite a note the distrust list hides (under its own, trusted writer). */
    admin: boolean;
    /**
     * May this caller set or clear the `reviewed` tag? REST: an admin token (the dashboard's Review view). MCP: never, an
     * admin MCP connection is an agent, and `reviewed` records a person accepting a note.
     */
    mayReview: boolean;
    /** Set when the caller is pinned to a namespace: the note must live there. */
    ownNs?: string;
  },
  id: number,
  tags: string[] | undefined,
  facts: unknown
): NoteUpdateCheck {
  // hideArchived: updating a forgotten note would echo its text back; it must be restored first.
  const target = store.readVisible(id, { hideArchived: true, includeDistrusted: c.admin });
  if (!target) return { ok: false, why: "missing" };
  if (c.ownNs !== undefined && target.namespace !== c.ownNs) return { ok: false, why: "other-namespace" };
  // task / handoff / task.* tags belong to task_put and session_handoff; `reviewed` to an admin's review. Checked on the
  // tags as sent and, when `facts` rewrites them, on the tags that will be stored.
  assertPlainWriteTags(tags, target.tags);
  assertReviewedTag(tags, target.tags, c.mayReview);
  const merged = withFacts(tags, facts, target.tags);
  if (merged !== tags) {
    assertPlainWriteTags(merged, target.tags);
    assertReviewedTag(merged, target.tags, c.mayReview);
  }
  return { ok: true, target, tags: merged };
}

// ---- r2-improvement #3: overwrites are never silent -----------------------------------------------------------------

/** Lines of diff an overwrite notice or a stale-write reply carries. */
const NOTICE_DIFF_LINES = 12;

/**
 * An update replaced text a DIFFERENT writer wrote: who, when, which rev, and a short line diff, plus one plain sentence for
 * the agent to pass on. Null when the text did not change or the caller wrote it itself. Line diff goes through printable().
 */
export function overwriteNotice(before: NoteRecord, after: NoteRecord, me: string): { replaced_other_writer: { by: string; at: string; old_rev: number; line_diff: string[] }; notice: string } | null {
  if (!before.written_by || before.written_by === me) return null;
  if (before.title === after.title && before.body === after.body) return null;
  const diff = lineDiff(before.body, after.body, NOTICE_DIFF_LINES);
  return {
    replaced_other_writer: { by: before.written_by, at: before.updated_at, old_rev: before.rev, line_diff: diff },
    notice:
      `You replaced text that "${printable(before.written_by, 60)}" wrote (rev ${before.rev}). Tell the user, and pass if_rev next time so a ` +
      "change by someone else is not overwritten unseen. The old text is in the note's history.",
  };
}

/**
 * A stale if_rev: who changed the note since the caller's revision, how, the current revision and a short diff from the text
 * the caller had to the text now, so the agent can merge without another read and without a blind forced retry.
 */
export function staleDetail(store: Store, id: number, ifRev: number): { message: string; stale: Record<string, unknown> } | null {
  const cur = store.readVisible(id, { hideArchived: true });
  if (!cur) return null;
  const later = store.historyOf(id).filter((e) => e.version >= ifRev).sort((x, y) => x.version - y.version);
  const mine = later[0];
  const by = [...new Set(later.map((e) => e.saved_by).filter(Boolean))];
  const changedBy = by.length ? by : cur.written_by ? [cur.written_by] : [];
  const how = later.length ? [...new Set(later.map((e) => (e.reason === "update" ? "edited the text" : e.reason)))].join(", ") : "changed tags or settings (the text is the same)";
  const lineDiffOut = mine ? lineDiff(mine.body, cur.body, NOTICE_DIFF_LINES) : [];
  const who = changedBy.length ? changedBy.map((w) => `"${printable(w, 60)}"`).join(", ") : "another writer";
  return {
    message: `stale write: note ${id} is at rev ${cur.rev} (you have ${ifRev}); ${who} ${how} since your read. Merge with the diff below and retry with if_rev ${cur.rev}`,
    stale: { current_rev: cur.rev, your_rev: ifRev, changed_by: changedBy[0] ?? "", changed_by_all: changedBy, changed_at: cur.updated_at, how, title: cur.title, line_diff: lineDiffOut },
  };
}
