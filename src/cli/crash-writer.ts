// One writer for `monomem check --crash`: opens the store at argv[2] and saves notes in a loop, printing "ACK <id>" (written
// with a synchronous write, after the save returned) for each one the store acknowledged. The checker kills it with SIGKILL at
// a random moment. Not a command: the checker starts it.
import "../quiet-sqlite.js";
import { writeSync } from "node:fs";
import { Store } from "../store.js";

const [dbPath, label] = process.argv.slice(2);
if (!dbPath || !label) process.exit(2);
const store = new Store(dbPath, { busyTimeoutMs: 8000, bodyIndex: "off" });
const busy = (e: unknown): boolean => /locked|busy/i.test((e as Error)?.message ?? "");
const gone = (e: unknown): boolean => /EPIPE|ERR_STREAM_DESTROYED|EBADF/.test(String((e as NodeJS.ErrnoException)?.code ?? ""));
for (let i = 0; ; i++) {
  try {
    // bulkImport: the flood guard (a limit on writes per minute) must not hold the test's own writes.
    const n = store.create({ title: `crash-${label}-${i}`, body: `crash test note ${label} ${i} ${"x".repeat(200)}` }, { bulkImport: true });
    writeSync(1, `ACK ${n.id}\n`);
  } catch (e) {
    // Skipped: another writer held the lock too long (not acknowledged, so not counted). Stop quietly: the checker closed the pipe.
    // Anything else is a real failure: say so on stderr and stop, instead of spinning with nothing saved.
    if (busy(e)) continue;
    if (gone(e)) process.exit(0);
    process.stderr.write(`crash-writer: ${(e as Error)?.message ?? String(e)}\n`);
    process.exit(1);
  }
}
