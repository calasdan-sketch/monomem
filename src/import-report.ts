// What `monomem import --file` and POST /import say about a file, beyond "Imported N": notes with no text, trust marks that were
// removed, and progress for a big file. Plain words, because the person running it may never have seen the file's format.
import { describeTrustStripped, type TrustStripped } from "./import-trust.js";

/** Field names people use for the text of a note when they write the file by hand. */
const BODY_ALIASES = ["content", "text", "note", "notes", "message", "description", "markdown", "contents", "value", "data", "details"];

/** Counts, over a whole file, the notes that have a title but no `body`, and which other fields they have instead. */
export class ImportShape {
  total = 0;
  empty = 0;
  /** Other field -> how many empty-bodied notes carry it. */
  alt: Record<string, number> = {};

  observe(note: unknown): void {
    if (!note || typeof note !== "object") return;
    const o = note as Record<string, unknown>;
    this.total++;
    if (typeof o.body === "string" && o.body.trim()) return;
    this.empty++;
    for (const f of BODY_ALIASES) if (typeof o[f] === "string" && (o[f] as string).trim()) this.alt[f] = (this.alt[f] ?? 0) + 1;
  }

  get allEmpty(): boolean {
    return this.total > 0 && this.empty === this.total;
  }

  /** One sentence per problem, in plain words. */
  warnings(): string[] {
    if (!this.empty) return [];
    const found = Object.keys(this.alt);
    const hint = found.length
      ? ` These notes have text in "${found.join('", "')}" instead. Monomem reads the text of a note from a field named "body": rename it and import again (notes already imported are skipped, not doubled).`
      : ` Monomem reads the text of a note from a field named "body" (a note is {"title": "...", "body": "..."}).`;
    return [`${this.empty} of ${this.total} note${this.total === 1 ? " has" : "s have"} no "body" text, so ${this.empty === 1 ? "it was" : "they were"} saved with a title only.${hint}`];
  }
}

/** The first line of the report. Not plain success when nothing that came in has any text. */
export function importHeadline(imported: number, skipped: number | undefined, shape: ImportShape): string {
  const tail = skipped ? `, skipped ${skipped} already present` : "";
  if (imported > 0 && shape.allEmpty) return `Imported ${imported} note(s)${tail}, but WARNING: every one has an empty body (no text), so it is probably not what you meant.`;
  return `Imported ${imported} note(s)${tail}.`;
}

/** Every extra line for the report (text-less notes, removed trust marks). */
export function importWarnings(shape: ImportShape, report: { trustStripped?: TrustStripped }): string[] {
  const t = describeTrustStripped(report.trustStripped);
  return [...shape.warnings(), ...(t ? [t] : [])];
}

/** Adds a batch's removed-trust counts to the running total. */
export function mergeTrustStripped(total: { trustStripped?: TrustStripped }, batch: { trustStripped?: TrustStripped }): void {
  const b = batch.trustStripped;
  if (!b) return;
  const t = (total.trustStripped ??= { notes: 0, marks: {} });
  t.notes += b.notes;
  for (const [k, v] of Object.entries(b.marks)) t.marks[k] = (t.marks[k] ?? 0) + v;
}

/** A progress line on stderr for a big file (not for --json, so its output stays one JSON document). */
export function importProgress(done: number, of: number, startedMs: number, json: boolean): void {
  if (json || of < 1000) return;
  const secs = Math.round((Date.now() - startedMs) / 1000);
  process.stderr.write(`  ...${done} of ${of} notes handled (${secs}s)\n`);
}
