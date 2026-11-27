// Save-time conflict candidates (report 03 C1b/C1c). When a note is saved, find live notes in the SAME namespace about the same
// subject (FTS over its title and body words, plus a tiny synonym table) and flag the pair when the new text flips a value, adds
// or removes a negation, or announces a switch ("switched to", "migrated to", "instead of", "no longer"). A HEURISTIC, ENGLISH
// ONLY: it records a `conflicts_with` link and tells the writer; it never deletes, supersedes or edits anything. Search uses the
// link to put the newer note first. `why` is a fixed sentence, never note text: the link table sits outside the sealed-body store.
// link to put the newer note first (search-service.ts applyConflicts). False positives cost a reorder plus a label, not data.
import type { NoteRecord, Store } from "./store.js";
import { extractKeywords } from "./keywords.js";
import { canon, synonymsOf } from "./search-synonyms.js";

export type ConflictKind = "negation" | "switch" | "value";
export interface ConflictFlag {
  kind: ConflictKind;
  why: string;
}
export const MAX_CANDIDATES = 12;
export const MAX_SUBJECT_TERMS = 8;
/** Only short, fact-shaped notes are compared: in long notes (chat sessions, logs) negations and numbers are everywhere and mean nothing. */
export const MAX_FACT_CHARS = 600;

const NEG = /\b(?:not|never|no longer|no|cannot|cant|can't|won't|wont|don't|dont|doesn't|doesnt|isn't|isnt|aren't|disabled|rolled back|reverted|stopped|without|deprecated)\b/gi;
const SWITCH = /\b(?:(?:switched|migrated|moved|changed|upgraded|downgraded)(?: \w+){0,4}? to|replaced(?: \w+){0,3}? with|now uses?|instead of|no longer)\s+([\w./-]+)?/i;
const STOPISH = new Set(["the", "our", "all", "any", "for", "new", "old", "now", "was", "and", "that", "this", "with", "from", "last", "next", "main", "primary"]);

const textOf = (n: Pick<NoteRecord, "title" | "body">): string => `${n.title}\n${n.body}`.slice(0, 4000);
const isFact = (n: Pick<NoteRecord, "title" | "body">): boolean => n.title.length + n.body.length <= MAX_FACT_CHARS;
const negCount = (s: string): number => (s.match(NEG) ?? []).length;
const numbers = (s: string): Set<string> => new Set(s.match(/\b\d+(?:[.,:]\d+)*[a-z%]*\b/gi) ?? []);
const valueTokens = (s: string): Set<string> => new Set(s.toLowerCase().match(/\b(?:[a-z]+-)+[a-z]*\d+\b|\b[a-z]+\d+[a-z\d]*\b/g) ?? []);

/** Content terms of a text, synonym-folded: the subject words two notes share. */
export function subjectTerms(s: string): Set<string> {
  return new Set(
    extractKeywords(s.toLowerCase())
      .filter((w) => !STOPISH.has(w) && !/^\d+$/.test(w))
      .map((w) => canon(w))
  );
}

/** What flagConflict reads from the newer text; the same `next` is compared with up to 13 older notes in a row, so it is computed once. */
interface NextFacts {
  n: string;
  terms: Set<string>;
  sw: RegExpExecArray | null;
  negs: boolean;
  values: Set<string>;
  nums: Set<string>;
}
let lastNext: NextFacts | null = null;
function nextFacts(n: string): NextFacts {
  if (lastNext?.n === n) return lastNext;
  lastNext = { n, terms: subjectTerms(n), sw: SWITCH.exec(n), negs: negCount(n) > 0, values: valueTokens(n), nums: numbers(n) };
  return lastNext;
}

/** Whether `next` (the newer text) contradicts `prev`, and how. Null when they merely overlap. Pure: no store access. */
export function flagConflict(prev: Pick<NoteRecord, "title" | "body">, next: Pick<NoteRecord, "title" | "body">): ConflictFlag | null {
  if (!isFact(prev) || !isFact(next)) return null;
  const p = textOf(prev);
  const f = nextFacts(textOf(next));
  const pt = subjectTerms(p);
  const shared = [...f.terms].filter((w) => pt.has(w));
  const sw = f.sw;
  if (shared.length < (sw ? 1 : 2)) return null;
  if (sw && !SWITCH.test(p)) {
    const target = (sw[1] ?? "").toLowerCase().replace(/[.,]$/, "");
    if (!target || !p.toLowerCase().includes(target)) return { kind: "switch", why: "the newer note announces a switch (switched to, migrated to, instead of, no longer)" };
  }
  if (shared.length >= 2 && (negCount(p) > 0) !== f.negs) return { kind: "negation", why: "newer note adds or drops a negation on the same subject" };
  const pv = valueTokens(p);
  const nv = f.values;
  if (nv.size && pv.size && [...nv].every((v) => !pv.has(v))) return { kind: "value", why: "the newer note gives a different value for the same subject" };
  const pn = numbers(p);
  const nn = f.nums;
  if (shared.length >= 3 && pn.size && nn.size && [...nn].every((v) => !pn.has(v))) return { kind: "value", why: "the newer note gives a different number for the same subject" };
  return null;
}

export interface ConflictCandidate extends ConflictFlag {
  id: number;
  title: string;
}

/** Below this many live notes every word is searched; above it, words found in more than COMMON_WORD_SHARE of them are left out. */
const COMMON_WORD_MIN_NOTES = 2000;
const COMMON_WORD_SHARE = 0.1;
const COMMON_WORD_KEEP = 3;
const BOILERPLATE_SHARE = 0.5;

/** Older live notes in the same namespace the new note contradicts, best first. Reads only; the caller records them. */
export function findConflictCandidates(store: Store, note: NoteRecord): ConflictCandidate[] {
  if ((note.kind ?? "note") !== "note" || !isFact(note)) return [];
  // Longer words are rarer, so the 8 longest subject terms (plus their synonyms) find the same older notes with far less
  // full-text work: the 24-term OR query made a save 4x slower at 10k notes (perf report 50).
  const subject = [...nextFacts(textOf(note)).terms].sort((a, b) => b.length - a.length).slice(0, MAX_SUBJECT_TERMS);
  let terms = subject.flatMap((t) => synonymsOf(t)).slice(0, 16);
  if (terms.length === 0) return [];
  // r8: a word that is in most notes (boilerplate, a template) finds no subject but makes the query rank every note: a save cost
  // 55 ms at 35k notes, growing with the store (stress/bulk100k.mjs). In a big store keep only the words that are not everywhere.
  if (store.liveNoteTotal() >= COMMON_WORD_MIN_NOTES) {
    const { n, df } = store.prefixDocFreqs(terms);
    const rare = terms.filter((t) => (df.get(t) ?? 0) <= n * COMMON_WORD_SHARE);
    const common = terms.filter((t) => !rare.includes(t)).sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0));
    // r10 (review M1): the team's main subject ("production deploy region", in 20% of notes) is common too, and the rare words
    // left were synonyms and the new value ("west"), which never find the older note: recall fell to zero at 2000 notes. So the
    // COMMON_WORD_KEEP rarest common words stay in, unless they are boilerplate (in more than BOILERPLATE_SHARE of the notes).
    // ponytail: a note made only of boilerplate words still gets no query (returned [] below): ranking every note for them is the
    // O(store) save (and O(n^2) import) r8 removed. A conflict on a subject found in over half the notes is not looked for.
    const kept = common.filter((t) => (df.get(t) ?? 0) <= n * BOILERPLATE_SHARE).slice(0, COMMON_WORD_KEEP);
    terms = [...rare, ...kept];
    if (terms.length === 0) return [];
  }
  const hits = store.searchRanked(terms.join(" "), { namespace: note.namespace, limit: MAX_CANDIDATES + 1, anyTerm: true });
  const out: ConflictCandidate[] = [];
  for (const h of hits) {
    const o = h.note;
    if (o.id === note.id || (o.kind ?? "note") !== "note" || o.archived_at || o.superseded_by != null) continue;
    const older = Date.parse(o.created_at) < Date.parse(note.created_at) || (o.created_at === note.created_at && o.id < note.id);
    if (!older) continue;
    const f = flagConflict(o, note);
    if (f) out.push({ id: o.id, title: o.title, ...f });
  }
  return out.slice(0, 5);
}
