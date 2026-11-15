// Zero-dependency text similarity (moved out of consolidate.ts in 1.5.0): tokenizer, term-frequency maps, cosine over
// TF and TF-IDF vectors, Jaccard. Used by consolidate.ts (duplicate candidates) and store.ts (the similarity-edge graph).
// Imports nothing, so neither user joins an import cycle through it.

/** ~30 common English stopwords dropped before similarity scoring. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "for",
  "with", "is", "are", "was", "were", "be", "been", "being", "it", "its",
  "this", "that", "these", "those", "as", "at", "by", "from", "we",
  "you", "i", "he", "she", "they", "not", "no", "do", "does", "did",
  "my", "our", "your", "have", "has", "had", "am",
]);

/** Lowercase, split on non-alphanumeric, drop tokens < 2 chars + stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Term-frequency map for one token list. Exported so callers can tokenize
 * once per note and score many pairs without re-tokenizing (see
 * Store.rebuildEdgesCooperative / recomputeEdgesFor). */
export function termFreq(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/** Cosine similarity directly over two precomputed term-frequency maps.
 * Exported alongside termFreq for the same tokenize-once/score-many
 * callers. Identical math to cosineSimilarity(a, b). */
export function cosineOfFreq(a: Map<string, number>, b: Map<string, number>): number {
  // Two inputs with no content tokens at all carry no similarity signal --
  // score 0, not 1. The old "both empty => identical" rule promoted
  // content-free notes to exact-duplicate candidates.
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [tok, ca] of a) {
    const cb = b.get(tok);
    if (cb !== undefined) dot += ca * cb;
  }
  let na = 0;
  for (const ca of a.values()) na += ca * ca;
  let nb = 0;
  for (const cb of b.values()) nb += cb * cb;
  if (na === 0 || nb === 0) return 0;
  // Clamp to [0, 1]: term frequencies are non-negative so the true cosine
  // can't leave that range — only floating-point rounding can (e.g.
  // 1.0000000000000002 for identical inputs), which would break exact
  // comparisons like `score === 1` downstream.
  return Math.min(1, Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

/**
 * Cosine similarity of two texts over term-frequency vectors.
 * 1 = identical token multisets, 0 = no shared content tokens. Texts that
 * reduce to no content tokens (empty, stopwords only) score 0, not 1.
 */
export function cosineSimilarity(a: string, b: string): number {
  return cosineOfFreq(termFreq(tokenize(a)), termFreq(tokenize(b)));
}

/**
 * Jaccard similarity of two texts over token SETS (|intersection|/|union|).
 * Secondary metric — exported for tests and for callers that want a
 * set-overlap view rather than frequency weighting. Empty token sets score
 * 0, mirroring cosineSimilarity.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/**
 * Tokenize-once: term-frequency maps for a batch of notes, keyed by note
 * id. Edge scoring compares every pair in a namespace, so tokenizing
 * per-pair inside the pair loop re-runs the tokenizer O(n^2) times.
 * Precompute once here, score many times below (D-MEDIUM-2). Notes with no
 * content tokens map to an empty TF map (they score 0 with everything, per
 * cosineOfFreq's convention); they are kept in the map so callers don't
 * have to special-case missing ids.
 */
export function precomputeTfMaps(
  notes: Array<{ id: number; title: string; body: string }>
): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  for (const n of notes) out.set(n.id, termFreq(tokenize(`${n.title} ${n.body}`)));
  return out;
}

/**
 * Document frequencies over a set of TF maps: term -> number of documents
 * containing the term. The edge graph computes these per namespace, per
 * rebuild/recompute, so the IDF weights always reflect the corpus actually
 * being scored (I-HIGH-1).
 */
export function computeDocFreqs(tfMaps: Iterable<Map<string, number>>): Map<string, number> {
  const df = new Map<string, number>();
  for (const tf of tfMaps) {
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return df;
}

/**
 * Shared content-token count between two TF maps — the "minimum support"
 * floor for edge creation (I-HIGH-1). Iterates the smaller map.
 */
export function sharedTokenCount(a: Map<string, number>, b: Map<string, number>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small.keys()) if (big.has(t)) n++;
  return n;
}

/**
 * Smoothed inverse document frequency. The +1 in the numerator/denominator
 * plus the +1 floor keeps the weight strictly positive: a term present in
 * every document still carries its TF signal, and a term missing from the
 * DF table (can't happen in-graph, defensive anyway) doesn't zero out.
 */
export function idf(term: string, df: Map<string, number>, docCount: number): number {
  return idfFromCount(df.get(term) ?? 0, docCount);
}

/** idf() from a raw document frequency (for callers without a DF map). */
export function idfFromCount(docFreq: number, docCount: number): number {
  return Math.log((1 + docCount) / (1 + docFreq)) + 1;
}

/**
 * Minimum shared content tokens for a similarity edge. A single shared
 * token is the exact junk-edge mode raw-TF cosine had at 0.35
 * ("Dentist appointment" vs "see dentist thursday" scored 0.408 on one
 * token). The floor is IDF-independent, so it holds even when the corpus
 * is too small for IDF to discriminate (cold start). Chosen with the
 * threshold by the sweep in reviews/tier2-threshold-sweep/.
 */
export const MIN_SHARED_TOKENS_FOR_EDGE = 2;

/**
 * Cosine similarity over TF-IDF-weighted term vectors. Rare shared terms
 * count more than boilerplate that appears everywhere — the I-HIGH-1
 * correction: raw TF cosine let a single common token clear the edge
 * threshold, because TF has no notion of term rarity (llmem's 0.35 was
 * tuned on an IDF-weighted BM25 scale, a different metric entirely).
 *
 * docCount is the corpus size the DF table was computed over (per
 * namespace, per rebuild/recompute). Texts with no content tokens score 0,
 * not 1, mirroring cosineSimilarity.
 */
export function cosineTfIdf(
  a: Map<string, number>,
  b: Map<string, number>,
  df: Map<string, number>,
  docCount: number
): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  for (const [tok, ta] of a) {
    const tb = b.get(tok);
    if (tb !== undefined) {
      const w = idf(tok, df, docCount);
      dot += ta * w * tb * w;
    }
  }
  let na = 0;
  for (const [tok, ta] of a) {
    const w = ta * idf(tok, df, docCount);
    na += w * w;
  }
  let nb = 0;
  for (const [tok, tb] of b) {
    const w = tb * idf(tok, df, docCount);
    nb += w * w;
  }
  if (na === 0 || nb === 0) return 0;
  // Clamp to [0, 1]: TF-IDF weights are non-negative so the true cosine
  // can't leave that range — only floating-point rounding can.
  return Math.min(1, Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}
