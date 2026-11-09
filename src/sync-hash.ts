// The plain-file sync merge-base hash, in its own module so the store can record a base when it approves a held sync write.
import { createHash } from "node:crypto";

/** The parts of a note that sync compares. */
export interface NoteContent {
  namespace: string;
  title: string;
  body: string;
  tags: string[];
}

/** Same normalization the store applies to tags (trim, dedupe, drop empty). */
export function normTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((t) => String(t).trim()).filter(Boolean)));
}

/** Files are LF-only; a body's CR / CRLF is the same content. */
export const lf = (s: string): string => s.replace(/\r\n?/g, "\n");

/** Content hash used as the three-way merge base (16 hex chars). */
export function contentHash(c: NoteContent): string {
  return createHash("sha256")
    .update(JSON.stringify([c.namespace, c.title, lf(c.body), normTags(c.tags)]))
    .digest("hex")
    .slice(0, 16);
}
