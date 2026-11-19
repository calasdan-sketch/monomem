// An import file that does not pass attestation is not trusted to say which notes a person has already looked at.
// A hand-made or tampered file could otherwise arrive with `reviewed`, `confirmed` or `pinned` marks (as tags or as fields) and a
// high revision number, and skip the review queue. For such a note those marks are removed and the note is imported as new.
// A note whose attestation verifies keeps them. Kept apart from store.ts, which has a hard size limit.

/** Tags that only a person's action in this store may set. */
const TRUST_TAGS = new Set(["reviewed", "confirmed", "pinned"]);
const TRUST_FIELDS = ["reviewed", "confirmed", "pinned"] as const;

export interface TrustStripped {
  /** Notes that had at least one mark removed. */
  notes: number;
  /** How many of each mark were removed (tag:reviewed, field:rev, ...). */
  marks: Record<string, number>;
}

/**
 * The note without trust marks (a copy; the original is not changed). When it had none, the note itself is returned.
 * Counts are added to `report.trustStripped`.
 */
export function stripImportTrust<T extends { tags?: unknown }>(note: T, report?: { trustStripped?: TrustStripped }): T {
  const marks: string[] = [];
  const o = note as Record<string, unknown>;
  const tags = Array.isArray(o.tags) ? (o.tags as unknown[]) : null;
  const keepTags = tags ? tags.filter((t) => !(typeof t === "string" && TRUST_TAGS.has(t.trim().toLowerCase()))) : null;
  if (tags && keepTags && keepTags.length !== tags.length) for (const t of tags) if (!keepTags.includes(t)) marks.push(`tag:${String(t).trim().toLowerCase()}`);
  for (const f of TRUST_FIELDS) if (o[f] !== undefined && o[f] !== null && o[f] !== false) marks.push(`field:${f}`);
  if (!marks.length) return note; // a plain backup that only carries an edit count (rev) keeps it: that is how a restore keeps history
  // The revision number goes only together with a "person checked this" mark: that pair is what a hand-made file uses to skip review.
  if (o.rev !== undefined && o.rev !== null) marks.push("field:rev");
  const copy: Record<string, unknown> = { ...o };
  for (const f of TRUST_FIELDS) delete copy[f];
  if (marks.includes("field:rev")) delete copy.rev;
  if (keepTags) copy.tags = keepTags;
  if (report) {
    const ts = (report.trustStripped ??= { notes: 0, marks: {} });
    ts.notes++;
    for (const m of marks) ts.marks[m] = (ts.marks[m] ?? 0) + 1;
  }
  return copy as T;
}

/** Plain-language sentence for the import report, or "" when nothing was removed. */
export function describeTrustStripped(ts: TrustStripped | undefined): string {
  if (!ts || !ts.notes) return "";
  const names = Object.keys(ts.marks)
    .map((m) => m.replace(/^tag:|^field:/, "").replace(/^rev$/, "revision number"))
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");
  return (
    `${ts.notes} note${ts.notes === 1 ? "" : "s"} in this file had marks that say a person already checked ${ts.notes === 1 ? "it" : "them"} (${names}), ` +
    `but the file has no verified signature, so those marks were removed and the notes came in as new, unchecked notes. ` +
    `Look at them in the review queue.`
  );
}
