// Personal-data suggestions. PATTERN-BASED: it looks for the shape of an email address, phone number, card number,
// SSN/SIN, IBAN or street address. It will miss things (a name, a medical detail, a number written in words) and it will
// flag things that are not personal (a made-up phone number, an order number that happens to pass the card check).
// It only SUGGESTS: it never changes a note. Notes already labelled private are skipped.
import type { NoteRecord } from "./store.js";
import { secretAssignments } from "./security.js";

export type PiiKind = "email" | "phone" | "card" | "ssn-sin" | "iban" | "address" | "dob" | "secret";

export interface PiiHit {
  kind: PiiKind;
  /** The match with most characters replaced by "*": enough to recognise it, not enough to reuse it. */
  masked: string;
}

export function maskValue(s: string): string {
  const t = s.trim();
  if (t.length <= 3) return "*".repeat(t.length);
  return t[0] + t.slice(1, -2).replace(/[^\s]/g, "*") + t.slice(-2);
}

export function luhn(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

// Every pattern is bounded (no open-ended nested repeats) and findPii reads only the first MAX_SCAN characters and stops
// at MAX_HITS matches or when its time budget runs out, so a hostile note cannot make a scan slow.
export const MAX_SCAN = 16384;
const MAX_HITS = 50;
const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,7}\.[A-Za-z]{2,24}\b/g;
const PHONE = /(?<![\d-])(?:\+?1[\s.-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?![\d-])/g;
const CARD = /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g;
const SSN = /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g;
const SIN = /(?<![\d-])\d{3}[ -]\d{3}[ -]\d{3}(?![\d-])/g;
// Letters, digits and single spaces only (the two alternatives cannot overlap), so there is nothing to backtrack over.
const IBAN = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]| (?=[A-Z0-9])){11,42}/g;
const ADDRESS = /\b\d{1,5}[ \t]{1,4}(?:[A-Z][a-z]{1,20}\.?[ \t]{1,4}){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Bay|Court|Ct|Way|Place|Pl|Crescent|Cres)\b\.?/g;
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]{0,6}\\.?";
const DOB = new RegExp(
  "\\b(?:dob|d\\.o\\.b\\.?|date of birth|birth ?date|born|birthday)\\b[ \\t:,-]{0,4}(?:on[ \\t]{1,3})?(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|" + MONTH + "[ \\t]{1,3}\\d{1,2}(?:st|nd|rd|th)?,?[ \\t]{1,3}\\d{4}|\\d{1,2}(?:st|nd|rd|th)?[ \\t]{1,3}" + MONTH + ",?[ \\t]{1,3}\\d{4})",
  "gi"
);

export function findPii(input: string, budgetMs = 400): PiiHit[] {
  const text = input.length > MAX_SCAN ? input.slice(0, MAX_SCAN) : input;
  const hits: PiiHit[] = [];
  const deadline = Date.now() + budgetMs;
  // Hits are few (capped), so checking a new match against them is cheap.
  const taken: Array<[number, number]> = [];
  const free = (a: number, b: number): boolean => {
    for (const [x, y] of taken) if (a < y && b > x) return false;
    return true;
  };
  const add = (kind: PiiKind, index: number, value: string, masked?: string): void => {
    taken.push([index, index + value.length]);
    hits.push({ kind, masked: masked ?? maskValue(value) });
  };
  const done = (): boolean => hits.length >= MAX_HITS || Date.now() > deadline;
  const each = (re: RegExp, f: (m: RegExpExecArray) => void): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (!done() && (m = re.exec(text)) !== null) {
      if (m[0].length === 0) re.lastIndex++;
      else f(m);
    }
  };
  each(EMAIL, (m) => {
    const at = m[0].indexOf("@");
    add("email", m.index, m[0], m[0][0] + "*".repeat(Math.min(at - 1, 6)) + m[0].slice(at));
  });
  for (const s of secretAssignments(text, 10)) add("secret", s.index, text.slice(s.index, s.index + s.length), `${s.label}: ******`);
  each(CARD, (m) => {
    if (free(m.index, m.index + m[0].length) && luhn(m[0].replace(/[ -]/g, ""))) add("card", m.index, m[0]);
  });
  each(IBAN, (m) => {
    // The match can run into following capitals; try shorter endings at word boundaries.
    let s = m[0];
    for (let i = 0; i < 10; i++) {
      if (ibanValid(s)) {
        if (free(m.index, m.index + s.length)) add("iban", m.index, s);
        return;
      }
      const cut = s.lastIndexOf(" ");
      if (cut < 0) return;
      s = s.slice(0, cut);
    }
  });
  each(SSN, (m) => free(m.index, m.index + m[0].length) && add("ssn-sin", m.index, m[0]));
  each(SIN, (m) => free(m.index, m.index + m[0].length) && luhn(m[0].replace(/\D/g, "").padStart(12, "0")) && add("ssn-sin", m.index, m[0]));
  each(PHONE, (m) => free(m.index, m.index + m[0].length) && add("phone", m.index, m[0]));
  each(DOB, (m) => free(m.index, m.index + m[0].length) && add("dob", m.index, m[0], "date of birth: ******"));
  each(ADDRESS, (m) => free(m.index, m.index + m[0].length) && add("address", m.index, m[0]));
  return hits;
}

export interface PiiSuggestion {
  id: number;
  namespace: string;
  counts: Partial<Record<PiiKind, number>>;
  /** Up to three masked examples. */
  examples: string[];
  total: number;
}

const LABEL: Record<PiiKind, string> = { email: "email address", phone: "phone number", card: "card number", "ssn-sin": "SSN/SIN-style number", iban: "IBAN", address: "street address", dob: "date of birth", secret: "password or key written as text" };
export const piiKindName = (k: PiiKind): string => LABEL[k];

/** Scan live notes (already limited to what the caller may see). Notes already labelled private are skipped. */
export function scanPii(notes: NoteRecord[], limit = 500, budgetMs = 3000): { suggestions: PiiSuggestion[]; scanned: number; skippedPrivate: number } {
  const suggestions: PiiSuggestion[] = [];
  let skippedPrivate = 0;
  let scanned = 0;
  const deadline = Date.now() + budgetMs;
  for (const n of notes) {
    if (Date.now() > deadline) break;
    if ((n.sensitivity ?? "internal") === "private") {
      skippedPrivate++;
      continue;
    }
    scanned++;
    const hits = findPii(`${n.title}\n${n.body}`);
    if (!hits.length) continue;
    if (suggestions.length >= limit) continue;
    const counts: Partial<Record<PiiKind, number>> = {};
    for (const h of hits) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
    suggestions.push({ id: n.id, namespace: n.namespace, counts, examples: hits.slice(0, 3).map((h) => `${h.kind}: ${h.masked}`), total: hits.length });
  }
  return { suggestions, scanned, skippedPrivate };
}

export const describePii = (s: PiiSuggestion): string =>
  `#${s.id} looks like it holds ${Object.entries(s.counts).map(([k, c]) => `${c} ${piiKindName(k as PiiKind)}${c === 1 ? "" : "s"}`).join(", ")} (${s.examples.join("; ")})`;
