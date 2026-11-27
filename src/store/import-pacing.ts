// importNotes pacing (r8). A batch ends after IMPORT_LOCK_MS inside one write transaction (a fixed note count held the lock for
// seconds when a note costs milliseconds: another process's save waited 1-7 s), and the gap between batches is IMPORT_PAUSE_MS,
// longer than the longest sleep of SQLite's busy handler (100 ms), so a waiting writer is awake when the lock is free.
// stress/saver-latency.mjs (3000-note import, one save per 100 ms from another process): 5 saves in 15 s, median wait 1.2 s,
// worst 7.5 s with only a setImmediate gap; 108 saves, median 178 ms, worst 335 ms with this (import 15 s -> 25 s).
export const IMPORT_LOCK_MS = 250;
export const IMPORT_PAUSE_MS = 120;
/** Shortest lock hold a batch gets (r10, review L1): 0.01 ms meant one note per batch plus a 120 ms pause each. */
export const IMPORT_LOCK_MIN_MS = 50;
/** MONOMEM_IMPORT_LOCK_MS is a test hook: the suite sets it high so batches keep their fixed note counts. */
export const importLockMs = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.MONOMEM_IMPORT_LOCK_MS);
  return Number.isFinite(n) && n > 0 ? Math.max(n, IMPORT_LOCK_MIN_MS) : IMPORT_LOCK_MS;
};

/** Returns a function that says whether this batch has held the lock long enough (never less than IMPORT_LOCK_MIN_MS). */
export const sliceTimer = (ms: number): (() => boolean) => {
  const t0 = performance.now();
  const limit = Math.max(ms, IMPORT_LOCK_MIN_MS);
  return () => performance.now() - t0 > limit;
};

/**
 * The gap between batches; the caller's own transaction keeps the lock anyway, so there only the event loop is yielded. An
 * in-memory store (`:memory:`) has no other writer to wait for, so it only yields too.
 */
export const importPause = (inTransaction: boolean, inMemory = false): Promise<void> =>
  new Promise<void>((r) => (inTransaction || inMemory ? setImmediate(r) : setTimeout(r, IMPORT_PAUSE_MS)));
