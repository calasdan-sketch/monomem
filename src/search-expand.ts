// Synonym top-up for keyword search (see search-synonyms.ts). A search word that none of the notes already found contains is also
// searched under its synonyms; those hits count as a discounted match for the word they stand in for.
import type { NoteRecord, Store } from "./store.js";
import { searchStem } from "./keywords.js";
import { synonymsFor } from "./search-synonyms.js";

/** A synonym match is worth this much of an exact match. */
export const SYNONYM_DISCOUNT = 0.8;

export function synonymHits(
  store: Store,
  keywords: string[],
  have: ReadonlyArray<{ note: NoteRecord }>,
  limit: number,
  opts: Parameters<Store["searchRanked"]>[1]
): Array<{ note: NoteRecord; score: number }> {
  const widenable = keywords.filter((k) => !k.startsWith("#") && synonymsFor(k).length > 0);
  if (widenable.length === 0 || limit <= 0 || (process.env.MONOMEM_SYNONYMS ?? "").trim() === "0") return []; // MONOMEM_SYNONYMS=0 turns it off
  // Widen only a word that none of the notes already found contains: a word the store holds plenty of shows up in them.
  const texts = have.map((h) => `${h.note.title} ${h.note.body}`.toLowerCase());
  const lacking = widenable.filter((k) => !texts.some((t) => t.includes(searchStem(k.toLowerCase()))));
  if (lacking.length === 0) return [];
  const terms = [...new Set(lacking.flatMap(synonymsFor))].slice(0, 12);
  const seenIds = new Set(have.map((h) => h.note.id));
  const share = (SYNONYM_DISCOUNT * lacking.length) / keywords.length;
  return store
    .searchRanked(terms.join(" "), { ...opts, limit: limit + have.length, anyTerm: true })
    .filter((h) => !seenIds.has(h.note.id))
    .slice(0, limit)
    .map((h) => ({ note: h.note, score: h.score * share }));
}
