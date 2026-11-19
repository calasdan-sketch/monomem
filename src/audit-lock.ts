// A short-lived lock around "read the end of the audit log, build the next line(s), append them".
// Without it two programs appending at once (an import writing a big batch while `monomem add` runs) both chain from the same
// last line, and `monomem audit verify` reports a fork. The lock is a folder next to the log (mkdir is atomic on every system).
// It is held only for one append or one batch (at most about a thousand lines), and a lock left by a killed program is
// ignored after 10 seconds, so a crash never blocks the log. If the lock cannot be had after about 3 seconds the write goes
// ahead without it (a possible fork, which `audit verify` reports and does not hide) rather than losing the audit line.
import { mkdirSync, rmSync, statSync } from "node:fs";

const STALE_MS = 10_000;
const WAIT_MS = 3_000;
const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The lock folder for this log. */
export const auditLockPath = (logPath: string): string => `${logPath}.append.lock`;

/** Take the lock; returns its path to hand to releaseAuditLock, or undefined when it could not be had in time. */
export function takeAuditLock(logPath: string): string | undefined {
  const lock = auditLockPath(logPath);
  const until = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      return lock;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          mkdirSync(lock, { recursive: true }); // the log's folder is not there yet
          return lock;
        } catch {
          return undefined;
        }
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true }); // left by a killed program
      } catch {
        /* just released */
      }
    }
    if (Date.now() > until) return undefined;
    sleep(2);
  }
}

export function releaseAuditLock(lock: string | undefined): void {
  if (!lock) return;
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    /* gone already */
  }
}
