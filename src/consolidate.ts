// Auto-consolidation / dedup: fights memory bloat from agents re-storing
// the same facts.
//
// Zero-dependency text similarity (cosine over term-frequency vectors as the
// primary metric, Jaccard as a secondary) finds near-duplicate notes, and
// consolidateNotes merges a set of duplicate ids into one note (union of
// tags, deduplicated bodies) with optional deletion of the sources.
//
// Safety notes:
// - Candidates are found same-namespace ONLY. Namespaces are an isolation
//   boundary; merging across them would leak one project's facts into
//   another's.
// - findCandidates is O(n^2). That's fine at personal-store scale, but the
//   input is capped: beyond 2000 notes (or MAX_CANDIDATE_BYTES of text)
//   only the most recently created notes are scanned. Async call sites (MCP tool, CLI) use
//   findCandidatesCooperative, which yields to the event loop every few
//   thousand pair checks so a large scan doesn't stall concurrent traffic.

// CandidateScanError lives in errors.ts (re-exported by store.ts) with the other error classes.
import { Store, ValidationError, CandidateScanError, clampInt } from "./store.js";
import type { NoteRecord } from "./store.js";
import { maybeEmbed } from "./search-service.js";
import { currentWriter } from "./actor.js";
import { strictestLabel } from "./sensitivity.js";
import { tokenize, termFreq, cosineOfFreq } from "./text-sim.js";
// The text-similarity primitives moved to text-sim.ts (1.5.0) so store.ts can use them without importing this module;
// re-exported so existing imports from consolidate.ts keep working.
export { tokenize, termFreq, cosineOfFreq, cosineSimilarity, jaccardSimilarity, precomputeTfMaps, computeDocFreqs, sharedTokenCount, idf, idfFromCount, MIN_SHARED_TOKENS_FOR_EDGE, cosineTfIdf } from "./text-sim.js";

export interface CandidatePair {
  idA: number;
  idB: number;
  score: number;
}

/**
 * Similarity-band bounds and a honesty note: 0.95 (near-duplicate review
 * band) and 0.99 (auto-merge band) are heuristic defaults, NOT validated
 * cutoffs. They were chosen on judgment, not measured against labeled
 * real-world notes; short notes are especially noisy near 0.95 (few tokens
 * -> high variance). The design treats 0.95 as review-only -- the janitor
 * auto-merges only exact-duplicate strings via isAutoMergeSafe, whatever
 * the score -- so the unvalidated threshold can surface candidates without
 * ever deleting on its say-so alone.
 */
export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 1.0;

/** Clamp a caller-supplied similarity threshold into a sane band (0.5..1.0). */
export function clampThreshold(v: number | undefined, def = 0.95): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : def;
  return Math.min(Math.max(n, THRESHOLD_MIN), THRESHOLD_MAX);
}

/**
 * True when clampThreshold(v) would rewrite a caller-supplied value, so
 * CLIs can warn instead of silently rewriting user input.
 */
export function thresholdWasClamped(v: number | undefined): boolean {
  return (
    v !== undefined &&
    (typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < THRESHOLD_MIN ||
      v > THRESHOLD_MAX)
  );
}

/** Personal-store scale cap: scanning is O(n^2), so cap the input. */
export const MAX_CANDIDATE_NOTES = 2000;

/**
 * Size cap on the scanned text (title + body length in UTF-16 code units,
 * ~bytes; newest notes first): the
 * note-count cap alone still let 2000 near-max-size notes cost minutes of
 * CPU per scan.
 */
export const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;

/** Default wall-clock budget for a guarded (tool-facing) candidate scan. */
export const CANDIDATE_SCAN_DEADLINE_MS = 15_000;

/**
 * Cooperative-scan cadence: yield to the event loop this often while
 * scoring pairs. A 2000-note scan is ~2M pair checks (~1s of pure CPU);
 * without a yield that stalls every concurrent HTTP/MCP request. 8192
 * keeps each uninterrupted slice to a few milliseconds.
 */
export const CANDIDATE_YIELD_EVERY = 8192;

interface CandidateDoc {
  note: NoteRecord;
  freq: Map<string, number>;
}

/** All (i, j) index pairs with i < j over n docs. */
function* pairIndices(n: number): Generator<[number, number]> {
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) yield [i, j];
  }
}

function prepareCandidateDocs(
  notes: NoteRecord[],
  opts: { threshold?: number; limit?: number }
): { docs: CandidateDoc[]; threshold: number; limit: number } {
  const threshold = clampThreshold(opts.threshold, 0.95);
  const limit = clampInt(opts.limit, 50, 1, 500);
  // v16: captured observations and summaries are not duplicates to merge (each is one session's record, linked to its
  // files and session); every candidate scan (CLI, MCP, janitor) routes through here, so they are left out once.
  notes = notes.filter((n) => !n.kind || n.kind === "note");

  const newestFirst = (list: NoteRecord[]): NoteRecord[] =>
    [...list].sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id - x.id);
  let pool =
    notes.length > MAX_CANDIDATE_NOTES
      ? newestFirst(notes).slice(0, MAX_CANDIDATE_NOTES)
      : notes;
  const textBytes = (n: NoteRecord): number => n.title.length + n.body.length;
  if (pool.reduce((sum, n) => sum + textBytes(n), 0) > MAX_CANDIDATE_BYTES) {
    // Keep the newest notes that fit the byte budget.
    const kept: NoteRecord[] = [];
    let bytes = 0;
    for (const n of newestFirst(pool)) {
      bytes += textBytes(n);
      if (bytes > MAX_CANDIDATE_BYTES) break;
      kept.push(n);
    }
    pool = kept;
  }

  const docs = pool.map((note) => ({
    note,
    freq: termFreq(tokenize(`${note.title} ${note.body}`)),
  }));
  return { docs, threshold, limit };
}

/** Score one pair; append a CandidatePair when it clears the threshold. */
function collectCandidatePair(
  docs: CandidateDoc[],
  i: number,
  j: number,
  threshold: number,
  pairs: CandidatePair[]
): void {
  const na = docs[i].note;
  const nb = docs[j].note;
  if (na.id === nb.id) return;
  if (na.namespace !== nb.namespace) return; // never merge across namespaces
  const score = cosineOfFreq(docs[i].freq, docs[j].freq);
  // 1e-9 epsilon: floating-point rounding can put a true-1.0 score a hair
  // below the threshold (e.g. 0.9999999999999999 vs 1.0), which would
  // wrongly exclude exact duplicates at threshold 1.0.
  if (score + 1e-9 >= threshold) {
    // Snap FP noise at the boundary: a score within 1e-9 of 1 is an
    // exact duplicate as far as any consumer is concerned.
    const snapped = score > 1 - 1e-9 ? 1 : score;
    pairs.push({
      idA: Math.min(na.id, nb.id),
      idB: Math.max(na.id, nb.id),
      score: snapped,
    });
  }
}

function finalizeCandidatePairs(
  pairs: CandidatePair[],
  limit: number
): CandidatePair[] {
  pairs.sort((x, y) => y.score - x.score || x.idA - y.idA || x.idB - y.idB);
  return pairs.slice(0, limit);
}

/**
 * Find near-duplicate note pairs. Same-namespace only; each pair appears
 * once (idA < idB); sorted by score descending; capped at `limit`.
 * If more than 2000 notes are passed, only the 2000 most recently created
 * are scanned (documented performance guard).
 */
export function findCandidates(
  notes: NoteRecord[],
  opts: { threshold?: number; limit?: number } = {}
): CandidatePair[] {
  const { docs, threshold, limit } = prepareCandidateDocs(notes, opts);
  const pairs: CandidatePair[] = [];
  for (const [i, j] of pairIndices(docs.length)) {
    collectCandidatePair(docs, i, j, threshold, pairs);
  }
  return finalizeCandidatePairs(pairs, limit);
}

/**
 * Cooperative variant of findCandidates for async call sites (the MCP
 * candidates tool, the CLI): byte-identical results, but yields to the
 * event loop every CANDIDATE_YIELD_EVERY pair checks so a large scan
 * doesn't stall concurrent HTTP/MCP traffic. The background janitor keeps
 * the synchronous version -- its scan is already capped at
 * MAX_CANDIDATE_NOTES, and its callers (plus tests) rely on the sync
 * contract.
 */
export async function findCandidatesCooperative(
  notes: NoteRecord[],
  opts: {
    threshold?: number;
    limit?: number;
    /** Abort the scan (e.g. the requesting client disconnected). */
    signal?: AbortSignal;
    /** Give up after this many milliseconds of wall-clock time. */
    deadlineMs?: number;
  } = {}
): Promise<CandidatePair[]> {
  const deadline = opts.deadlineMs === undefined ? Infinity : Date.now() + opts.deadlineMs;
  // Checked before the scan and at every cooperative yield point.
  const checkBudget = (): void => {
    if (opts.signal?.aborted) throw new CandidateScanError("candidate scan cancelled");
    if (Date.now() > deadline) {
      throw new CandidateScanError(
        `candidate scan exceeded its ${opts.deadlineMs}ms budget; narrow it with a namespace`
      );
    }
  };
  checkBudget();
  const { docs, threshold, limit } = prepareCandidateDocs(notes, opts);
  const pairs: CandidatePair[] = [];
  let checked = 0;
  for (const [i, j] of pairIndices(docs.length)) {
    collectCandidatePair(docs, i, j, threshold, pairs);
    checked += 1;
    if (checked % CANDIDATE_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      checkBudget();
    }
  }
  return finalizeCandidatePairs(pairs, limit);
}

let guardedScanRunning = false;

/**
 * The tool-facing candidate scan: findCandidatesCooperative under a
 * process-wide single-flight guard (one scan at a time -- a second
 * concurrent call is refused, not queued) and a hard deadline (default
 * CANDIDATE_SCAN_DEADLINE_MS). Pass the request's AbortSignal so a
 * disconnected client stops burning CPU.
 */
export async function findCandidatesGuarded(
  notes: NoteRecord[],
  opts: { threshold?: number; limit?: number; signal?: AbortSignal; deadlineMs?: number } = {}
): Promise<CandidatePair[]> {
  if (guardedScanRunning) {
    throw new CandidateScanError(
      "another duplicate-candidate scan is already running; retry when it finishes"
    );
  }
  guardedScanRunning = true;
  try {
    return await findCandidatesCooperative(notes, {
      ...opts,
      deadlineMs: opts.deadlineMs ?? CANDIDATE_SCAN_DEADLINE_MS,
    });
  } finally {
    guardedScanRunning = false;
  }
}

export interface ConsolidationPreview {
  namespace: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
}

/**
 * Compute what a merge of these notes would produce, without writing
 * anything. Shared by consolidateNotes and the dry-run paths.
 */
export function buildConsolidationPreview(
  notes: NoteRecord[],
  mergedTitle?: string
): ConsolidationPreview {
  const title =
    mergedTitle?.trim() ||
    notes.reduce((longest, n) =>
      n.title.length >= longest.title.length ? n : longest
    ).title;

  // Deduplicated concatenation: exact-duplicate bodies appear once.
  const seen = new Set<string>();
  const bodies: string[] = [];
  for (const n of notes) {
    if (!seen.has(n.body)) {
      seen.add(n.body);
      bodies.push(n.body);
    }
  }

  return {
    namespace: notes[0].namespace,
    title,
    body: bodies.join("\n\n---\n\n"),
    tags: [...new Set(notes.flatMap((n) => n.tags))],
    // store.create slices source to 200 chars; union here and let it enforce.
    source: [...new Set(notes.map((n) => n.source).filter(Boolean))].join(","),
  };
}

/**
 * Resolve + validate the ids for a consolidation: 2+ distinct ids, all
 * exist, all in one namespace. Throws ValidationError otherwise.
 */
export function resolveConsolidationNotes(store: Store, ids: number[]): NoteRecord[] {
  if (!ids || ids.length < 2) {
    throw new ValidationError("consolidation needs at least 2 note ids");
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length < 2) {
    throw new ValidationError("consolidation needs at least 2 distinct note ids");
  }
  const notes = uniqueIds.map((id) => {
    const n = store.read(id); // gate-ok: admin consolidation by ids: mixed trusted/distrusted sources are refused below
    if (!n) throw new ValidationError(`no note with id ${id}`);
    store.refuseAgentOnPinned(id, "merging it"); // merging deletes it: refused up front, not half-way through
    // Merging rewrites and deletes notes, which cannot wait in the review queue: in an approve-first namespace it is the operator's alone.
    if (currentWriter() !== "cli" && store.isApproveFirst(n.namespace)) {
      throw new ValidationError(`namespace "${n.namespace}" is approve-first: merging notes there is done by the operator (monomem CLI), not by an agent`);
    }
    if (n.kind && n.kind !== "note") {
      throw new ValidationError(`note ${id} is a captured ${n.kind}; only ordinary notes are consolidated`);
    }
    if (n.archived_at) {
      // Merging deletes the sources and creates a LIVE note: that would
      // permanently destroy an archived (forgotten, restorable) note.
      throw new ValidationError(`note ${id} is archived; restore it before consolidating`);
    }
    return n;
  });
  const namespace = notes[0].namespace;
  if (!notes.every((n) => n.namespace === namespace)) {
    throw new ValidationError("cannot consolidate notes from different namespaces");
  }
  return notes;
}

/** Score at or above which the background janitor considers auto-merging a pair. */
export const AUTO_MERGE_SCORE = 0.99;

/**
 * Auto-merge eligibility gate (blocker #6).
 *
 * tokenize() drops single-char tokens and stopwords, so two terse notes
 * that differ only in single-letter codes (or punctuation/stopwords)
 * collapse to the same token set and score a perfect cosine 1.0. The 0.99
 * score band alone would then DELETE genuinely distinct notes -- silent
 * data loss by the background janitor.
 *
 * The safer rule (chosen over a minimum-token-count floor): auto-merge only
 * when the two notes' title AND body are exactly equal as strings. A
 * token-count floor (e.g. >= 4 tokens) still has a blind spot -- two long
 * notes whose ONLY differences are single-char/stopword tokens also
 * collapse to an identical token set and would auto-merge. Exact string
 * equality has no such blind spot. Near-identical pairs that differ in any
 * way are left for human review via memory_consolidation_candidates, never
 * merged blindly.
 */
export function isAutoMergeSafe(a: NoteRecord, b: NoteRecord): boolean {
  return a.title === b.title && a.body === b.body;
}

export interface JanitorOptions {
  /**
   * Blocker #4 -- when set, the candidate pool is restricted to this
   * namespace. Mirrors the MCP memory_consolidate tool (and
   * memory_consolidation_candidates): reads-from grants confer read access,
   * never the right to restructure/delete another namespace's notes, so
   * writes always stay in the server's own namespace. Unset means the whole
   * store (legacy single-tenant behavior).
   */
  ownNamespace?: string;
  /** Candidate-detection threshold (default 0.95). */
  threshold?: number;
  /** Score at/above which a pair is considered for auto-merge (default 0.99). */
  autoMergeScore?: number;
}

export interface JanitorResult {
  /** All >= threshold candidate pairs found (for the human-review log line). */
  candidateCount: number;
  merged: Array<{ idA: number; idB: number; mergedId: number }>;
  /** Pairs the janitor attempted but failed to merge (with reasons). */
  skipped: Array<{ idA: number; idB: number; reason: string }>;
}

/**
 * One background auto-consolidation pass (blockers #4/#6 hardened):
 *
 * - Only pairs scoring >= autoMergeScore are eligible for automatic
 *   merging; weaker candidates are counted for human review, never merged.
 * - Even an eligible pair auto-merges only when isAutoMergeSafe() holds
 *   (exact title+body equality); token-collapse near-duplicates are left
 *   for review, never merged blindly.
 * - When ownNamespace is set, only that namespace's notes are scanned --
 *   the janitor can never merge/delete another namespace's notes.
 *
 * A single failing pair never aborts the pass: it is recorded in `skipped`.
 * Callers (start.ts) only log.
 */
export function autoConsolidate(
  store: Store,
  opts: JanitorOptions = {}
): JanitorResult {
  const pool = janitorPool(store, opts);
  const candidates = findCandidates(pool, {
    threshold: opts.threshold ?? 0.95,
    limit: 200,
  });
  return mergeJanitorCandidates(store, pool, candidates, opts);
}

/**
 * Cooperative variant of autoConsolidate for the server's background
 * janitor: the candidate scan uses findCandidatesCooperative
 * (byte-identical results), yielding to the event loop every
 * CANDIDATE_YIELD_EVERY pair checks so a large scan doesn't stall
 * concurrent API/MCP traffic. The merge loop itself is unchanged (merges
 * are rare and each is a short transaction).
 */
export async function autoConsolidateCooperative(
  store: Store,
  opts: JanitorOptions = {}
): Promise<JanitorResult> {
  const pool = janitorPool(store, opts);
  const candidates = await findCandidatesCooperative(pool, {
    threshold: opts.threshold ?? 0.95,
    limit: 200,
  });
  return mergeJanitorCandidates(store, pool, candidates, opts);
}

/** The candidate pool for one janitor pass (own-namespace when configured). */
function janitorPool(store: Store, opts: JanitorOptions): NoteRecord[] {
  // Live notes only: archived notes are "forgotten but restorable"; the
  // janitor must never merge-and-delete them (that resurrects the content as
  // a live note and destroys the archive entry).
  // Notes touched by a distrusted writer never enter the pool: merging a
  // distrusted copy of a trusted note would make the merged note hidden and
  // the trusted original vanish from every default read.
  const live = store.exportAll({ live: true }); // gate-ok: candidate scan is filtered with store.filterVisible before use
  const visible = store.filterVisible(live);
  return opts.ownNamespace ? visible.filter((n) => n.namespace === opts.ownNamespace) : visible;
}

/**
 * Merge the eligible candidate pairs (shared by the sync and cooperative
 * janitor passes): only pairs scoring >= autoMergeScore AND passing
 * isAutoMergeSafe (exact title+body equality) are merged; everything else
 * stays a human-review candidate.
 */
function mergeJanitorCandidates(
  store: Store,
  pool: NoteRecord[],
  candidates: CandidatePair[],
  opts: JanitorOptions
): JanitorResult {
  const byId = new Map(pool.map((n) => [n.id, n]));
  const autoMergeScore = opts.autoMergeScore ?? AUTO_MERGE_SCORE;

  const consumed = new Set<number>();
  const merged: JanitorResult["merged"] = [];
  const skipped: JanitorResult["skipped"] = [];
  for (const c of candidates) {
    if (c.score < autoMergeScore) continue;
    if (consumed.has(c.idA) || consumed.has(c.idB)) continue;
    // Blocker #6: a 0.99+ score is not enough -- token collapse can put a
    // perfect 1.0 on genuinely distinct notes. Auto-merge exact duplicates
    // only; anything else stays a human-review candidate.
    const na = byId.get(c.idA);
    const nb = byId.get(c.idB);
    if (!na || !nb || !isAutoMergeSafe(na, nb)) continue;
    try {
      const note = consolidateNotes(store, [c.idA, c.idB], {
        deleteSources: true,
      });
      // Sync context: fire-and-forget. maybeEmbed never throws (the write
      // already succeeded; the embedding is best-effort), so an un-awaited
      // call here cannot fail the janitor pass.
      void maybeEmbed(store, note);
      consumed.add(c.idA);
      consumed.add(c.idB);
      merged.push({ idA: c.idA, idB: c.idB, mergedId: note.id });
    } catch (e) {
      skipped.push({
        idA: c.idA,
        idB: c.idB,
        reason: (e as Error).message,
      });
    }
  }
  return { candidateCount: candidates.length, merged, skipped };
}

/**
 * Merge a set of duplicate notes into one. Creates the merged note, then
 * deletes the sources by default (the point is dedup) unless
 * `deleteSources: false` is passed. Throws ValidationError on bad input;
 * callers (MCP/CLI) map that to a clean error.
 *
 * The merged note inherits the OLDEST source's created_at (so time-scoped
 * search keeps working -- a merge must not time-travel notes to "now");
 * updated_at stays "now" because the merge really did just happen.
 *
 * Embeddings: store.create does not embed. Async callers should
 * `await maybeEmbed(store, merged)` afterwards (see search-service.ts) so
 * the merged note is visible to semantic search; the synchronous janitor
 * path fires it without awaiting (maybeEmbed never throws).
 *
 * Atomicity + TOCTOU (blockers #7/#8): the whole merge -- validation
 * re-read, create, and all guarded deletes -- runs inside ONE SQLite
 * transaction via Store.transaction(). Inside it, every source is re-read
 * and its rev compared against the pre-transaction read; any change or
 * vanish aborts the merge (ValidationError, full rollback). Deletes are
 * guarded (DELETE ... WHERE id = ? AND rev = ?), mirroring
 * Store.update()'s compare-and-swap, so a writer racing between the re-read
 * and the delete cannot be silently destroyed. No partial merge can survive
 * a crash: either the merged note plus all deletes commit together, or
 * nothing does.
 */
export function consolidateNotes(
  store: Store,
  ids: number[],
  opts: { deleteSources?: boolean; mergedTitle?: string } = {}
): NoteRecord {
  const notes = resolveConsolidationNotes(store, ids);
  const preview = buildConsolidationPreview(notes, opts.mergedTitle);
  const expectedRevs = new Map(notes.map((n) => [n.id, n.rev]));
  const deleteSources = opts.deleteSources !== false;
  const sourceIds = new Set(notes.map((n) => n.id));
  // A merge of a distrusted note with a trusted one would hide the trusted
  // text (the merged note carries every source's writers) and, with
  // deleteSources, remove the trusted original. Refuse; merge like with like.
  const flags = notes.map((n) => store.isDistrusted(n));
  if (flags.some(Boolean) && !flags.every(Boolean)) {
    throw new ValidationError(
      "cannot consolidate: some of these notes were touched by a distrusted writer and some were not, so the merged note would be hidden " +
        "(and the trusted originals lost from every default read). Consolidate the distrusted ones together, or leave them out."
    );
  }

  return store.transaction(() => {
    // Re-read every source inside the transaction: the ids were validated
    // against a pre-transaction read, and a concurrent writer may have
    // changed or deleted them since. Abort (full rollback) on any mismatch.
    for (const [id, expectedRev] of expectedRevs) {
      const current = store.read(id); // gate-ok: re-read of an id the pool already admitted
      if (!current) {
        throw new ValidationError(
          `note ${id} was deleted while preparing the merge; aborting`
        );
      }
      if (current.rev !== expectedRev) {
        throw new ValidationError(
          `note ${id} changed while preparing the merge ` +
            `(rev ${expectedRev} -> ${current.rev}); aborting`
        );
      }
    }

    // Score the merged note's edges under the write lock (a consistent
    // snapshot; cheap via the namespace's cached index). The sources are
    // excluded -- they are about to be deleted -- and scoring runs before
    // create() so the merged note can't score against itself.
    const edgePairs = store.planEdges(
      preview.namespace,
      preview.title,
      preview.body,
      store.getEdgeThreshold(),
      sourceIds
    ).pairs;

    const merged = store.create(
      {
        namespace: preview.namespace,
        title: preview.title,
        body: preview.body,
        tags: preview.tags,
        source: preview.source,
        // Oldest source's date: a merge must not time-travel notes to "now".
        created_at: notes.reduce(
          (oldest, n) => (n.created_at < oldest ? n.created_at : oldest),
          notes[0].created_at
        ),
        // The merged note is as sensitive as its most sensitive source: a merge must never be a way to lower a label.
        sensitivity: strictestLabel(notes),
      },
      // Edges were pre-scored above; apply them directly instead of
      // re-running the scan inside the transaction.
      {
        skipEdges: true,
        lint: "trusted",
        // The sources are about to be deleted; their writers are kept on the
        // merged note for good, so not_written_by and the distrust list still
        // see whose text it was made from.
        mergedFromWriters: sourceWriters(notes),
        // Retention: the merged note keeps a TTL only when EVERY source had
        // one (then the latest deadline, so nothing is forgotten earlier than
        // intended). If any source was meant to be kept forever, so is the merge.
        ...(notes.every((n) => n.expires_at)
          ? { expiresAt: notes.map((n) => n.expires_at as string).sort().pop() }
          : {}),
      }
    );
    store.applyEdgePairs(merged.id, edgePairs);

    if (deleteSources) {
      for (const [id, rev] of expectedRevs) {
        // Guarded delete, mirroring update()'s compare-and-swap: a writer
        // racing between the re-read above and this delete would silently
        // lose its write otherwise. A miss here means the row changed or
        // vanished mid-transaction -- abort rather than half-merge.
        if (!store.deleteIfRev(id, rev)) {
          throw new ValidationError(
            `note ${id} changed during the merge; aborting`
          );
        }
      }
    }
    // The merged note is stamped with whoever ran the merge; whose text it was
    // made from is stored in merged_from_writers (and returned here).
    return merged;
  });
}


/**
 * The writers whose text a merge is made of: every source's content writer, the
 * original author a verified attestation vouched for (as a label and as a
 * `<server_id>/<label>` id), and whatever those sources were themselves merged
 * from. Unknown writers ("") are not names and are left out.
 */
export function sourceWriters(notes: NoteRecord[]): string[] {
  const out = new Set<string>();
  for (const n of notes) {
    if (n.written_by) out.add(n.written_by);
    if (n.attested_writer && n.attested_by) {
      out.add(n.attested_writer);
      out.add(`${n.attested_by}/${n.attested_writer}`);
    }
    for (const w of n.merged_from_writers ?? []) out.add(w);
  }
  return [...out].sort();
}

/**
 * Group candidate pairs into connected components (union-find) so an
 * A-B, B-C chain merges as one group instead of failing on the second
 * pair's already-deleted note.
 */
export function groupCandidateIds(pairs: CandidatePair[]): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    // Path compression.
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  for (const p of pairs) {
    const ra = find(p.idA);
    const rb = find(p.idB);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(id);
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a - b));
}
