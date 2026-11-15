// The checks before an update by id, shared by REST PUT /notes/:id and MCP state_write (1.5.0 P-01). Both surfaces used to
// write them out separately, in different orders; MCP's order once let a reserved-tag refusal reveal a hidden note (A2).
// The order here: visibility first (a note the distrust list hides, a forgotten one, or a missing one is "missing"), then
// the namespace (a pinned caller may only change its own namespace's notes: a read grant never confers write access), then
// facts and the tag guards on the note the caller may see.
import type { NoteRecord, Store } from "./store.js";
import { assertPlainWriteTags, assertReviewedTag } from "./reserved-tags.js";
import { withFacts } from "./facts.js";

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
