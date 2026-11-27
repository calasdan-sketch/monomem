// BEGIN IMMEDIATE whose lock wait gives up only when the database is stuck, not merely busy.
//
// SQLite's busy handler is not fair: a writer that commits and starts its next write at once takes the lock again before
// a sleeping waiter wakes up. Measured on Windows: 8 processes writing in a loop with 150 ms transactions (a slow disk or
// a busy machine) left one create waiting 15-16 s where its fair share was ~1 s. Past the 20 s busy timeout such a wait
// failed with "database is locked" although every other writer kept committing (CI run 43931988177). Here the wait is
// taken in short slices and checks between them whether anyone committed: it gives up after `waitMs` with NO commit from
// anyone (a writer really stuck: the old behaviour), or when the total budget (MONOMEM_BUSY_RETRY_MS, attempts and retries together) is used up.
// ponytail: no fairness, only a progress-aware deadline; a cross-process FIFO (ticket queue) if waits that long matter.

import type { DatabaseSync } from "node:sqlite";

/** SQLite's own wait per slice; the commit check runs between slices. */
const POLL_MS = 250;

const isBusy = (e: unknown): boolean => (Number((e as { errcode?: unknown })?.errcode) & 0xff) === 5;
const pragmaNum = (db: DatabaseSync, name: string): number => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0]);

/**
 * TOTAL time one write may spend getting the lock: the busy_timeout waits AND the retries together (never less than one busy_timeout).
 * MONOMEM_BUSY_RETRY_MS changes it (0 = no retries: one busy_timeout, then "database is busy"). The wait is synchronous: a server
 * process cannot answer anything else meanwhile, so lower it there (see docs/configuration.md).
 */
export const BUSY_RETRY_MS = 60_000;
const MAX_BUSY_RETRY_MS = 600_000;
export function busyBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MONOMEM_BUSY_RETRY_MS;
  if (raw === undefined || raw.trim() === "") return BUSY_RETRY_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), MAX_BUSY_RETRY_MS) : BUSY_RETRY_MS;
}
const RETRY_PAUSE_MIN_MS = 20;
const RETRY_PAUSE_MAX_MS = 400;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepMs = (ms: number): void => void Atomics.wait(sleeper, 0, 0, ms);

export interface BeginHooks {
  /** Monotonic clock in ms (test hook; default performance.now). */
  now?: () => number;
  /** Called each time a refused attempt is retried (test hook). */
  onRetry?: () => void;
}

/**
 * BEGIN IMMEDIATE on `db`, waiting as long as its busy_timeout while no other writer commits (see above). A zero-wait caller
 * (bestEffortWrite) and short waits (hooks, 150-250 ms: they must not stall an agent) fail at once; a longer wait that still
 * ends busy while others are still committing is retried, with random growing pauses, until `budgetMs` is used up IN TOTAL
 * (attempts included, monotonic clock), so a crowd of writers stops colliding in step and the "database is busy, nothing saved"
 * refusal almost never reaches the agent. `budgetMs` is a test hook; the default is MONOMEM_BUSY_RETRY_MS.
 */
export function beginImmediate(db: DatabaseSync, budgetMs: number = busyBudgetMs(), hooks: BeginHooks = {}): void {
  const now = hooks.now ?? ((): number => performance.now());
  const waitMs = pragmaNum(db, "busy_timeout");
  const start = now();
  const deadline = start + Math.max(waitMs, budgetMs);
  let seen = waitMs >= RETRY_MIN_WAIT_MS ? pragmaNum(db, "data_version") : 0;
  for (let pause = RETRY_PAUSE_MIN_MS; ; pause = Math.min(pause * 2, RETRY_PAUSE_MAX_MS)) {
    try {
      return beginImmediateOnce(db, Math.max(0, deadline - now()), now);
    } catch (e) {
      if (!isBusy(e) || waitMs < RETRY_MIN_WAIT_MS || now() + pause >= deadline) throw e;
      const v = pragmaNum(db, "data_version");
      if (v === seen) throw e; // nobody committed during a whole wait: the lock is stuck, not crowded. Refuse as before.
      seen = v;
      hooks.onRetry?.();
      sleepMs(Math.round(pause * (0.5 + Math.random())));
    }
  }
}
const RETRY_MIN_WAIT_MS = 1000;

/** One attempt: gives up after `waitMs` with no commit by anyone, or when `capMs` (what is left of the total budget) is used. */
function beginImmediateOnce(db: DatabaseSync, capMs: number, clock: () => number): void {
  const waitMs = pragmaNum(db, "busy_timeout");
  if (waitMs <= POLL_MS) {
    db.exec("BEGIN IMMEDIATE"); // a zero-wait caller (bestEffortWrite) keeps failing fast
    return;
  }
  const start = clock();
  let lastProgress = start;
  let version = pragmaNum(db, "data_version"); // changes whenever another connection commits
  db.exec(`PRAGMA busy_timeout = ${POLL_MS};`);
  try {
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        return;
      } catch (e) {
        if (!isBusy(e)) throw e;
        const now = clock();
        const v = pragmaNum(db, "data_version");
        if (v !== version) [version, lastProgress] = [v, now];
        if (now - lastProgress >= waitMs || now - start >= capMs) throw e;
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${waitMs};`);
  }
}

/**
 * The next rev of a note, read from the row UNDER the write lock. update() reads the note before it takes the lock, and another
 * process may bump it in between; two blind updates must not both be acked with the same rev (the second would erase the
 * first from history, and a stale if_rev would be accepted). Falls back to the pre-lock values when the row is gone.
 */
export function nextRevUnderLock(db: DatabaseSync, id: number, fallback: { rev: number; baseRev: number }): { rev: number; baseRev: number } {
  const row = db.prepare("SELECT rev FROM notes WHERE id = ?").get(id) as { rev: number } | undefined;
  return row ? { rev: row.rev + 1, baseRev: row.rev } : fallback;
}

/**
 * Is any note body sealed (encrypted)? On a plain store nothing matches, so without an index this reads every row (about 1 s at
 * 500k notes, paid by every hook). A partial index holds only sealed rows, so the answer is one page read. Made once, best effort.
 */
export function sealedRowsExist(db: DatabaseSync): boolean {
  let from = "notes";
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_notes_sealed ON notes(id) WHERE body_enc IS NOT NULL");
    from = "notes INDEXED BY idx_notes_sealed";
  } catch {
    /* read-only file, another process holds the lock, or no body_enc column yet: use the plain scan */
  }
  return !!db.prepare(`SELECT 1 FROM ${from} WHERE body_enc IS NOT NULL LIMIT 1`).get();
}

export { openDatabase } from "./open-retry.js";
