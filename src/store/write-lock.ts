// BEGIN IMMEDIATE whose lock wait gives up only when the database is stuck, not merely busy.
//
// SQLite's busy handler is not fair: a writer that commits and starts its next write at once takes the lock again before
// a sleeping waiter wakes up. Measured on Windows: 8 processes writing in a loop with 150 ms transactions (a slow disk or
// a busy machine) left one create waiting 15-16 s where its fair share was ~1 s. Past the 20 s busy timeout such a wait
// failed with "database is locked" although every other writer kept committing (CI run 43931988177). Here the wait is
// taken in short slices and checks between them whether anyone committed: it gives up after `waitMs` with NO commit from
// anyone (a writer really stuck: the old behaviour), or after MAX_PROGRESS_WAITS times `waitMs` in all.
// ponytail: no fairness, only a progress-aware deadline; a cross-process FIFO (ticket queue) if waits that long matter.

import type { DatabaseSync } from "node:sqlite";

/** SQLite's own wait per slice; the commit check runs between slices. */
const POLL_MS = 250;
/** Hard cap, in multiples of the configured wait, on a wait that keeps seeing other writers commit. */
const MAX_PROGRESS_WAITS = 3;

const isBusy = (e: unknown): boolean => (Number((e as { errcode?: unknown })?.errcode) & 0xff) === 5;
const pragmaNum = (db: DatabaseSync, name: string): number => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0]);

/** BEGIN IMMEDIATE on `db`, waiting as long as its busy_timeout while no other writer commits (see above). */
export function beginImmediate(db: DatabaseSync): void {
  const waitMs = pragmaNum(db, "busy_timeout");
  if (waitMs <= POLL_MS) {
    db.exec("BEGIN IMMEDIATE"); // a zero-wait caller (bestEffortWrite) keeps failing fast
    return;
  }
  const start = Date.now();
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
        const now = Date.now();
        const v = pragmaNum(db, "data_version");
        if (v !== version) [version, lastProgress] = [v, now];
        if (now - lastProgress >= waitMs || now - start >= waitMs * MAX_PROGRESS_WAITS) throw e;
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${waitMs};`);
  }
}
