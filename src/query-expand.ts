// Identifier-aware search terms (2026-11-18). The search index lower-cases and splits on punctuation, so a note that says
// "user_session_timeout", "user-session-timeout" or "src/auth/session.ts" is found by its separate words, but a note that says
// "getUserById" is ONE indexed word (getuserbyid) and "get user by id" never found it. The index is not changed (that needs a
// migration and a re-index of every store); the QUERY is widened instead:
//
//   - a camelCase / PascalCase word in the query also matches the same words written apart ("getUserById" -> get AND user AND by AND id);
//   - a snake_case / kebab-case / dotted / path word in the query also matches the glued form ("user_session_timeout" -> usersessiontimeout);
//   - a plain query of 2 to 6 words also matches those words glued together ("get user by id" -> getuserbyid, "user session timeout" -> usersessiontimeout).
//
// A query with none of these is left exactly as it was. Known limits: a PART of a camelCase word is not found by its own word
// ("timeout" does not find "userSessionTimeout"; only the whole identifier does), and the words must be in the same order as
// the identifier. Everything is bounded: at most 8 widened words, 8 parts each, and a word over 64 characters is left alone.
const MAX_WIDENED = 8;
const MAX_PARTS = 8;
const MAX_WORD = 64;
const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const CAMEL = /[a-z\d][A-Z]|[A-Z]{2,}[a-z]/;

/** Lower-case parts of an identifier: camelCase, PascalCase, HTTPServer, snake_case, kebab-case, a.b.c, path/like. */
export function identifierParts(word: string): string[] {
  return word
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/**
 * The AND expression of a typed search. `words` are the raw query words and `tokens` the same words already quoted and
 * prefixed for FTS5 (store.ts); the result is `tokens.join(" AND ")` unless a word or the whole query can be widened.
 */
export function expandIdentifiers(words: string[], tokens: string[]): string {
  let widened = 0;
  const terms = tokens.map((tok, i) => {
    const w = words[i] ?? "";
    if (w.length > MAX_WORD || widened >= MAX_WIDENED) return tok;
    const parts = identifierParts(w);
    if (parts.length < 2 || parts.length > MAX_PARTS) return tok;
    const alts = [tok];
    if (CAMEL.test(w)) alts.push(`(${parts.map((p) => `${quote(p)}*`).join(" AND ")})`);
    const glued = parts.join("");
    if (glued !== w.toLowerCase()) alts.push(`${quote(glued)}*`);
    widened++;
    return alts.length > 1 ? `(${alts.join(" OR ")})` : tok;
  });
  const all = terms.join(" AND ");
  if (words.length >= 2 && words.length <= 6 && words.every((w) => /^[\p{L}\p{N}]+$/u.test(w))) {
    const glued = words.join("").toLowerCase();
    if (glued.length <= MAX_WORD) return `(${all} OR ${quote(glued)}*)`;
  }
  return all;
}
