// Chinese, Japanese and Korean search. The FTS index (unicode61) keeps a whole run of such characters as ONE word, so a query
// only matched a note that began its run with the same characters (6 of 6 probes found nothing). This tops a short result up
// with a substring match on character pairs (bigrams), scored by how many of the query's pairs the note holds.
// ponytail: a LIKE scan over live plain-text rows (capped), fine for thousands of notes; a bigram FTS column is the upgrade
// for 100k+. Encrypted bodies are not scanned (their text is not in the notes table); titles still are.
import type { DatabaseSync } from "node:sqlite";

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script_Extensions=Katakana}\p{Script=Hangul}]{2,}/gu;
export const MAX_BIGRAMS = 24;
/** Rows loaded into memory per query (was 2000). */
export const SCAN_CAP = 500;
/** Above this many live notes the unindexed pair scan is skipped (one query would read every note); the FTS rows are still returned. Raise it by editing, or move to a pair index. */
export const SCAN_MAX_NOTES = 150_000;

export const hasCjk = (q: string): boolean => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(q);

/** Overlapping character pairs of every CJK run of 2+ characters in `q` (a run of exactly 2 gives itself). */
export function cjkBigrams(q: string): string[] {
  const out = new Set<string>();
  for (const run of q.slice(0, 4096).match(CJK_RUN) ?? []) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length && out.size < MAX_BIGRAMS; i++) out.add(chars[i] + chars[i + 1]);
  }
  return [...out];
}

type Row = { id: number; title: string; body: string } & Record<string, unknown>;

/** Rows to append after the FTS rows: notes holding the query's pairs (1 of 1-2, else at least 2), best first, never one FTS already returned. */
export function cjkTopUp<R extends { id: number }>(
  db: DatabaseSync,
  have: R[],
  query: string,
  limit: number,
  scope: { namespace?: string; live: string; rangeSql: string; rangeParams: unknown[] }
): Array<R & { score: number }> {
  const pairs = cjkBigrams(query);
  if (!pairs.length || have.length >= limit) return have as Array<R & { score: number }>;
  try {
    if (Number((db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c) > SCAN_MAX_NOTES) return have as Array<R & { score: number }>;
    return scan(db, have, pairs, limit, scope);
  } catch {
    return have as Array<R & { score: number }>; // a failure of this extra scan must not throw away the FTS rows already found
  }
}

function scan<R extends { id: number }>(db: DatabaseSync, have: R[], pairs: string[], limit: number, scope: { namespace?: string; live: string; rangeSql: string; rangeParams: unknown[] }): Array<R & { score: number }> {
  const like = pairs.map(() => "(notes.title LIKE ? OR notes.body LIKE ?)").join(" OR ");
  const params = pairs.flatMap((p) => [`%${p}%`, `%${p}%`]);
  const ns = scope.namespace ? " AND notes.namespace = ?" : "";
  const rows = db
    .prepare(`SELECT notes.* FROM notes WHERE (${like})${ns} AND ${scope.live}${scope.rangeSql} ORDER BY notes.updated_at DESC, notes.id DESC LIMIT ${SCAN_CAP}`)
    .all(...(params as never[]), ...((scope.namespace ? [scope.namespace] : []) as never[]), ...(scope.rangeParams as never[])) as unknown as Row[];
  const seen = new Set(have.map((h) => h.id));
  const need = pairs.length <= 2 ? 1 : 2; // grammar words add pairs no note shares; two matching pairs is real overlap
  const scored = rows
    .filter((r) => !seen.has(r.id))
    .map((r) => {
      const text = `${r.title} ${r.body}`;
      return { r, n: pairs.reduce((c, p) => c + (text.includes(p) ? 1 : 0), 0) };
    })
    .filter((x) => x.n >= need)
    .sort((a, b) => b.n - a.n)
    .slice(0, limit - have.length)
    .map((x) => ({ ...(x.r as unknown as R), score: x.n / pairs.length }));
  return [...(have as Array<R & { score: number }>), ...scored];
}
