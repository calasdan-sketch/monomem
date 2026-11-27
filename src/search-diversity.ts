// One noisy writer must not bury everyone else. Report 03 (F3): 20 keyword-stuffed notes with the real note's title, all from one
// writer, pushed the real note out of the top 5 (the pool held it; the ranking did not). No rival caps this.
// A writer's first WRITER_FREE notes keep their score; each one after halves it. Order inside one writer never changes (scores sort
// down and the factor shrinks down), so a pool written by a single writer is returned exactly as before, except that a
// writer's repeat of one of its own titles is damped from the first repeat.
/** Candidates fetched per result wanted, so damping has others to pull forward. */
export const POOL_FACTOR = 4;
/** ... and never fewer than this (a search for 5 still looks at 50: one writer's 20 decoys cannot fill the pool). */
export const POOL_MIN = 50;
export const WRITER_FREE = 3;
export const WRITER_DECAY = 0.5;

export function dampenCrowdingWriters<T extends { note: { written_by?: string; title?: string }; score: number }>(hits: T[]): T[] {
  const writers = new Set(hits.map((h) => h.note.written_by ?? ""));
  if (writers.size < 2) return hits;
  const seen = new Map<string, number>();
  const titles = new Set<string>();
  return [...hits]
    .sort((a, b) => b.score - a.score)
    .map((h) => {
      const w = h.note.written_by ?? "";
      // The same title again from the same writer is a restatement, not new evidence: it starts already past the free ones.
      const tk = `${w}\u0000${(h.note.title ?? "").trim().toLowerCase()}`;
      const dup = h.note.title ? titles.has(tk) : false;
      titles.add(tk);
      const k = Math.max(seen.get(w) ?? 0, dup ? WRITER_FREE : 0);
      seen.set(w, k + 1);
      return k < WRITER_FREE ? h : { ...h, score: h.score * WRITER_DECAY ** (k - WRITER_FREE + 1) };
    });
}

/** Near-duplicate collapse: a hit whose words overlap an already-kept, higher-scored hit this much (Jaccard) is a restatement. */
export const DUP_JACCARD = 0.85;
/** A flood cluster: this much word overlap with CLUSTER_FREE or more higher-scored hits (a loose bar; one writer repeating itself with a counter changed). */
export const CLUSTER_JACCARD = 0.7;
/** The first this many members of a cluster keep their score (a short version chain is not a flood). */
export const CLUSTER_FREE = 3;
/** A flood member keeps this share of its score. */
export const CLUSTER_FACTOR = 0.25;
/** A restatement keeps this share of its score (it is moved down, never dropped). */
export const DUP_FACTOR = 0.5;
const DUP_CHARS = 2000;
const ASCII_ONLY = /^[\x00-\x7f]*$/;
const WORDSET_CACHE_MAX = 4000;
const wordSets = new Map<string, Set<string>>(); // by note id, revision and text lengths: a repeat search does not re-tokenise the same notes
export const wordSet = (n: { id?: number; rev?: number; title?: string; body?: string }): Set<string> => {
  const key = n.id === undefined ? "" : `${n.id}:${n.rev ?? 0}:${n.title?.length ?? 0}:${n.body?.length ?? 0}`;
  const cached = key ? wordSets.get(key) : undefined;
  if (cached) return cached;
  const text = `${n.title ?? ""} ${(n.body ?? "").slice(0, DUP_CHARS)}`.toLowerCase();
  // Plain ASCII text gives the same words from a much cheaper pattern than the Unicode-property one.
  const w = new Set(text.match(ASCII_ONLY.test(text) ? /[a-z0-9]+/g : /[\p{L}\p{N}]+/gu) ?? []);
  if (key) {
    if (wordSets.size >= WORDSET_CACHE_MAX) wordSets.clear(); // ponytail: wholesale reset; an LRU only if a profile shows churn
    wordSets.set(key, w);
  }
  return w;
};

/**
 * True when jaccard(a, b) >= DUP_JACCARD, the same answer as the plain division. Scans the smaller set and gives up as soon as
 * matching every word still unread could not reach the threshold (most pairs differ early).
 */
export function nearCopy(a: Set<string>, b: Set<string>, min = DUP_JACCARD): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size / (big.size || 1) < min) return false;
  const union = a.size + b.size;
  let inter = 0;
  let left = small.size;
  for (const x of small) {
    if ((inter + left) / (union - (inter + left)) < min) return false;
    left--;
    if (big.has(x)) inter++;
  }
  return inter / (union - inter || 1) >= min;
}

/** Jaccard overlap of two word sets (0 to 1). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/** Ten rewordings of one fact must not fill the first five places: the 2nd and later near-copies of a higher-scored hit are halved. */
export function dampenNearDuplicates<T extends { note: { id?: number; rev?: number; title?: string; body?: string }; score: number }>(hits: T[]): T[] {
  if (hits.length < 2) return hits;
  const sorted = [...hits].sort((a, b) => b.score - a.score);
  const kept: Array<Set<string>> = [];
  const seen: Array<Set<string>> = [];
  return sorted.map((h) => {
    const w = wordSet(h.note);
    const big = w.size >= 6;
    const dup = big && kept.some((k) => nearCopy(w, k));
    // ponytail: O(n^2) set compares over the pool (<= 200 hits, 2000 chars each); an LSH sketch only if a profile shows it.
    const flood = big && !dup && seen.filter((k) => nearCopy(w, k, CLUSTER_JACCARD)).length >= CLUSTER_FREE;
    seen.push(w);
    if (dup) return { ...h, score: h.score * DUP_FACTOR };
    if (flood) return { ...h, score: h.score * CLUSTER_FACTOR };
    kept.push(w);
    return h;
  });
}
