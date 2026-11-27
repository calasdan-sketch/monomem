// Two first-open failures that clear on their own (round 3): (1) right after a hard kill (kill -9, power loss) Windows can answer a
// bare "disk I/O error" because the dead process's -shm lock is not released yet (01-F3); (2) several processes opening a NEW,
// empty data folder at the same moment can get "database is locked" while one of them switches the file to WAL (benchmark
// round: 6 of 150 starts). Nothing is lost in either case. Open, run the first statements that take those locks (WAL switch, one
// read), and retry with a short random pause before saying so in plain words.
import { DatabaseSync } from "node:sqlite";
import { isNewStore, markNewStoreScanned } from "./fresh-marker.js";

const OPEN_TRIES = 8;
const PAUSE_BASE_MS = 100;
export const OPEN_IOERR_MESSAGE =
  "Monomem could not open its database just now (disk I/O error). Another Monomem process probably stopped a moment ago and its lock has not cleared. Nothing is lost: wait a few seconds and run it again.";

const code = (e: unknown): number => Number((e as { errcode?: unknown })?.errcode) & 0xff;
const isIoErr = (e: unknown): boolean => code(e) === 10 || /disk i\/o error/i.test(String((e as Error)?.message ?? e));
const isBusyOpen = (e: unknown): boolean => code(e) === 5 || code(e) === 6 || /database is locked|database is busy/i.test(String((e as Error)?.message ?? e));
const sleepMs = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Open `dbPath`; retry on SQLITE_IOERR and on a busy/locked first open (not for :memory:). `open` and `sleep` are test hooks. */
export function openDatabase(
  dbPath: string,
  open: (p: string) => DatabaseSync = (p) => new DatabaseSync(p),
  sleep: (ms: number) => void = sleepMs,
): DatabaseSync {
  if (dbPath === ":memory:") return open(dbPath);
  const isNew = isNewStore(dbPath);
  for (let attempt = 1; ; attempt++) {
    let db: DatabaseSync | undefined;
    try {
      db = open(dbPath);
      db.exec("PRAGMA busy_timeout = 1000;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
      if (isNew) markNewStoreScanned(dbPath);
      return db;
    } catch (e) {
      try { db?.close(); } catch { /* already closed */ }
      const io = isIoErr(e);
      if (!io && !isBusyOpen(e)) throw e;
      if (attempt >= OPEN_TRIES) throw io ? new Error(OPEN_IOERR_MESSAGE) : e;
      sleep(Math.round(PAUSE_BASE_MS * attempt * (0.5 + Math.random())));
    }
  }
}
