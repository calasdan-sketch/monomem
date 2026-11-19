// Observed-evidence notes (PLAN D, 1.6). A writer can say what it observed for a note it creates (memory_save `evidence`):
// a test run, a file:line, a command, a URL, or a short pasted output. Reads then label the note
// `[observed: ...; cited by the writer, not checked]`, and `evidence: []` labels it `[inferred]`. Monomem does not run or open
// anything it is given: the label says the writer CLAIMS it saw this. Notes saved without the field keep their old shape.
// Evidence belongs to the version it was given with: an update makes a new version, which has no evidence until a new one
// is saved (the old evidence may no longer back the changed text).
// With `facts-need-evidence on`, an agent's confirm of a note that carries facts and has no evidence does not count.
// Storage: its own side table `note_evidence` (+ a delete trigger), made on the first write that carries evidence; the items are
// sealed at rest when encryption is on and pass through the secret redactor first. No schema bump.
// Free functions over the Store. Imports `type { Store }` only.

import type { NoteRecord, NoteRow, Store } from "../store.js";
import { ValidationError } from "../errors.js";
import { ENC_PREFIX_V3, decryptV3, encryptV3 } from "../crypto.js";
import { redactSecrets } from "../redact.js";
import { printable } from "../security.js";

export const EVIDENCE_KINDS = ["test", "file", "command", "url", "output"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export interface EvidenceItem { kind: EvidenceKind; ref: string }
export const MAX_EVIDENCE_ITEMS = 10;
export const MAX_EVIDENCE_REF = 300;
export const INFERRED_LABEL = "[inferred: the writer cited nothing it observed]";

const SCHEMA = `CREATE TABLE IF NOT EXISTS note_evidence (
  note_id INTEGER NOT NULL,
  note_rev INTEGER NOT NULL,
  items TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (note_id, note_rev)
);
CREATE TRIGGER IF NOT EXISTS note_evidence_ad AFTER DELETE ON notes BEGIN DELETE FROM note_evidence WHERE note_id = old.id; END;`;

const aad = (noteId: number, rev: number): string => `evidence|${noteId}|${rev}`;

/** note_evidence only ever gains rows in practice: an empty answer is re-asked at most once a second. */
const seen = new WeakMap<Store, { any: boolean; at: number }>();
function anyEvidence(s: Store): boolean {
  const c = seen.get(s);
  if (c && (c.any || Date.now() - c.at < 1000)) return c.any;
  const has = s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_evidence'").get() !== undefined;
  const any = has && s.db.prepare("SELECT 1 FROM note_evidence LIMIT 1").get() !== undefined;
  seen.set(s, { any, at: Date.now() });
  return any;
}

/** Checks the request value. undefined = not given; [] = the writer says it is inferred. */
export function checkEvidenceInput(v: unknown): EvidenceItem[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ValidationError('evidence must be a list of {kind, ref}, e.g. [{"kind":"file","ref":"src/a.ts:12"}], or [] for an inference');
  if (v.length > MAX_EVIDENCE_ITEMS) throw new ValidationError(`evidence has at most ${MAX_EVIDENCE_ITEMS} items`);
  return v.map((x, i) => {
    const o = (x ?? {}) as { kind?: unknown; ref?: unknown };
    if (typeof o.kind !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(o.kind)) {
      throw new ValidationError(`evidence[${i}].kind must be one of: ${EVIDENCE_KINDS.join(", ")}`);
    }
    const ref = typeof o.ref === "string" ? o.ref.replace(/\s+/g, " ").trim() : "";
    if (!ref) throw new ValidationError(`evidence[${i}].ref is required: the file:line, command, URL, test name or output you observed`);
    if (ref.length > MAX_EVIDENCE_REF) throw new ValidationError(`evidence[${i}].ref is at most ${MAX_EVIDENCE_REF} characters`);
    return { kind: o.kind as EvidenceKind, ref: redactSecrets(ref).text };
  });
}

/** create(): inside its write transaction, after the row exists. */
export function setEvidence(s: Store, noteId: number, rev: number, items: EvidenceItem[] | undefined, at: string): void {
  if (items === undefined) return;
  s.db.exec(SCHEMA);
  const json = JSON.stringify(items);
  const key = s.writeKey();
  s.db.prepare("INSERT OR REPLACE INTO note_evidence (note_id, note_rev, items, at) VALUES (?, ?, ?, ?)").run(noteId, rev, key ? encryptV3(json, key, aad(noteId, rev)) : json, at);
  seen.set(s, { any: true, at: Date.now() });
}

/** The evidence saved with this version of the note, or undefined when none was. */
export function evidenceOf(s: Store, noteId: number, rev: number): EvidenceItem[] | undefined {
  if (!anyEvidence(s)) return undefined;
  const r = s.db.prepare("SELECT items FROM note_evidence WHERE note_id = ? AND note_rev = ?").get(noteId, rev) as { items: string } | undefined;
  if (!r) return undefined;
  try {
    const json = r.items.startsWith(ENC_PREFIX_V3) ? decryptV3(r.items, s.readKey(), aad(noteId, rev)) : r.items;
    return JSON.parse(json) as EvidenceItem[];
  } catch {
    return [{ kind: "output", ref: "[evidence sealed: the key is missing]" }];
  }
}

export function evidenceLabel(items: EvidenceItem[]): string {
  if (!items.length) return INFERRED_LABEL;
  const first = items[0];
  return `[observed: ${first.kind} ${JSON.stringify(printable(first.ref, 60))}${items.length > 1 ? `, +${items.length - 1}` : ""}; cited by the writer, not checked]`;
}

/** rec(): `evidence`, `basis` and the label on a note saved with evidence; other notes keep their exact shape. */
export function annotateEvidence(s: Store, row: NoteRow, out: NoteRecord): NoteRecord {
  if (row.rev === undefined) return out;
  const items = evidenceOf(s, Number(row.id), Number(row.rev));
  if (!items) return out;
  out.basis = items.length ? "observed" : "inferred";
  out.evidence = items;
  out.evidence_label = evidenceLabel(items);
  return out;
}

export function factsNeedEvidence(s: Store): boolean {
  return s.getMeta("facts_need_evidence") === "on";
}

export function setFactsNeedEvidence(s: Store, on: boolean): void {
  s.setMeta("facts_need_evidence", on ? "on" : "off");
  s.audit({ op: "facts-need-evidence", detail: on ? "on" : "off" });
}
