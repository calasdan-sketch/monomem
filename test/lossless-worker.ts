// Child process of test/lossless-property.test.ts (not a test): random writes to a shared store until its time is up, or until it
// is killed. An acknowledgement line goes to the ack file only AFTER the Store call has returned, so a line in the file means
// "Monomem said yes". `node lossless-worker.js <db> <seed> <ms> <ackFile>`
import { appendFileSync } from "node:fs";
import { Store } from "../src/store.js";

const [dbPath, seedArg, msArg, ackFile] = process.argv.slice(2);
let x = Number(seedArg) * 2654435761 || 1;
const rnd = (n: number): number => {
  x = (Math.imul(x ^ (x >>> 15), 2246822519) + 1) >>> 0;
  return x % n;
};
const store = new Store(dbPath, { busyTimeoutMs: 8000 });
const ack = (o: object): void => appendFileSync(ackFile, JSON.stringify(o) + "\n");
const end = Date.now() + Number(msArg);
const ids = (): number[] => (store.db.prepare("SELECT id FROM notes WHERE kind = 'note' ORDER BY id LIMIT 12").all() as Array<{ id: number }>).map((r) => r.id);
for (let i = 0; Date.now() < end; i++) {
  const pool = ids();
  const pick = pool.length ? pool[rnd(pool.length)] : 0;
  const body = `w${seedArg}-${i}`;
  try {
    const op = rnd(10);
    if (op < 3 || !pick) {
      const n = store.create({ title: `n-${seedArg}-${i}`, body });
      ack({ id: n.id, rev: n.rev, body });
    } else if (op < 8) {
      const n = store.update(pick, { body });
      if (n) ack({ id: n.id, rev: n.rev, body });
    } else if (op < 9) {
      store.archive(pick);
    } else {
      store.restore(pick);
    }
  } catch {
    /* a refused write (busy, stale, archived) is not acknowledged and is not asserted on */
  }
}
store.close();
