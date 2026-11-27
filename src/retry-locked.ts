// Several servers starting at once can hit SQLite's "database is locked" at open (the first WAL switch can fail without waiting
// for busy_timeout). Wait a little and try again; any other error is thrown at once. Synchronous: the Store constructor is.
const LOCKED = /database is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i;

export function retryWhileLocked<T>(fn: () => T, tries = 6, baseMs = 150): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (i >= tries || !LOCKED.test(e instanceof Error ? e.message : String(e))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, baseMs * i + Math.floor(Math.random() * baseMs)); // jitter: stop the herd moving in step
    }
  }
}
