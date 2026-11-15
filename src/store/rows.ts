// Pure row helpers shared by store.ts and the src/store/* modules (1.5.0 store split). Imports only the pure taint.ts and
// types, so every user stays out of import cycles.

import type { NoteRecord } from "../store.js";
import { isTainted } from "../taint.js";

/** A hooked session with no event for this long no longer counts as open (same as extract.ts STALE_SESSION_MS). */
export const SESSION_IDLE_MS = 30 * 60_000;

export function tagsToStorage(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return "";
  // Store as a JSON array so tags can contain commas/spaces; dedupe + trim.
  const cleaned = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean)));
  return cleaned.length ? JSON.stringify(cleaned) : "";
}

export function parseTags(raw: string): string[] {
  if (!raw) return [];
  if (raw[0] === "[") {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a)) return a.filter((x) => typeof x === "string");
    } catch {
      /* fall through to legacy comma parse */
    }
  }
  return raw.split(",").map((t) => t.trim()).filter(Boolean); // legacy rows
}

/** Strength of a confirm kind: a weaker confirm never overwrites a stronger one for the same rev. */
export const CONFIRM_RANK: Record<string, number> = { corroborated: 1, admin: 2, human: 3 };

/** CONFIRM_RANK as SQL, for the kind stored in column `col`. */
export const rankSql = (col: string): string => `CASE ${col} WHEN 'human' THEN 3 WHEN 'admin' THEN 2 WHEN 'corroborated' THEN 1 ELSE 0 END`;

/** The times a note's re-confirmation clock may start from (the v20 columns). */
export interface DueRow {
  updated_at: string;
  content_at?: string | null;
  confirmed_at?: string | null;
  confirmed_kind?: string | null;
  confirmed_rev?: number | null;
  rev: number;
  grandfathered_at?: string | null;
}

/**
 * When a note's re-confirmation clock started (ms): the latest of its last CONTENT change (title/body), a person's or an
 * admin's confirm of its current rev (a corroboration releases the session-start hold but never restarts the clock), the
 * upgrade (grandfathered) and the mode switch. Due = this + days. The ONE formula for labels and counts. 0 = no usable time:
 * the caller treats that as not due.
 */
export function dueBase(r: DueRow, c: { set_at?: string }): number {
  const confirmed =
    r.confirmed_at && Number(r.confirmed_rev) === Number(r.rev) && (r.confirmed_kind === "human" || r.confirmed_kind === "admin") ? r.confirmed_at : null;
  const times = [r.content_at ?? r.updated_at, confirmed, r.grandfathered_at, c.set_at ?? null].map((t) => (t ? Date.parse(t) : NaN)).filter((t) => !Number.isNaN(t));
  return times.length ? Math.max(...times) : 0;
}

/**
 * A tainted note whose current rev has no HUMAN confirm: it may not be pinned or used as a replacement. Grandfathered notes
 * (from before the 1.4.0 upgrade) are included: they are exempt from the session-start hold only, so a 1.3.5 summary that
 * read the web shows as before but is not promoted without a person.
 */
export function needsHumanConfirm(n: Pick<NoteRecord, "tags" | "rev" | "confirmed_kind" | "confirmed_rev">): boolean {
  return isTainted(n.tags) && !(n.confirmed_kind === "human" && n.confirmed_rev === n.rev);
}
