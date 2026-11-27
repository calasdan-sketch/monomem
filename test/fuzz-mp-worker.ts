// Child of test/fuzz-multiproc.test.ts (not a test): CAS-update, blind-update, create and replace the same few notes until the time is
// up or it is killed. An ack line is written only AFTER the Store call returned. `node fuzz-mp-worker.js <db> <seed> <ms> <ackFile> <writer>`
import { appendFileSync } from "node:fs";
import { Store, StaleWriteError } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { rng } from "./fuzz-model-lib.js";

const [dbPath, seedArg, msArg, ackFile, writer] = process.argv.slice(2);
const r = rng(Number(seedArg));
const store = new Store(dbPath, { busyTimeoutMs: 10000 });
const ack = (o: object): void => appendFileSync(ackFile, JSON.stringify(o) + "\n");
const end = Date.now() + Number(msArg);
const ids = (): number[] => (store.db.prepare("SELECT id FROM notes WHERE kind = 'note' ORDER BY id LIMIT 6").all() as Array<{ id: number }>).map((x) => x.id);
for (let i = 0; Date.now() < end; i++) {
  const pool = ids();
  const pick = pool[Math.floor(r() * pool.length)];
  const body = `${writer}-${i}-${Math.floor(r() * 1e9)}`;
  const op = r();
  try {
    actorStore.run({ label: writer, authed: true }, () => {
      if (op < 0.1 || !pick) {
        const n = store.create({ title: `n-${writer}-${i}`, body });
        ack({ id: n.id, rev: n.rev, body, base: 0 });
      } else if (op < 0.7) {
        const cur = store.read(pick);
        if (!cur) return;
        try {
          const n = store.update(pick, { body }, { ifRev: cur.rev });
          if (n) ack({ id: n.id, rev: n.rev, body, base: cur.rev });
        } catch (e) {
          if (!(e instanceof StaleWriteError)) throw e; // a lost race is the expected answer, and is never acknowledged
        }
      } else if (op < 0.9) {
        const n = store.update(pick, { body });
        if (n) ack({ id: n.id, rev: n.rev, body, base: -1 });
      } else if (op < 0.95) {
        store.archive(pick);
      } else {
        store.restore(pick);
      }
    });
  } catch {
    /* busy / refused: not acknowledged, not asserted on */
  }
}
store.close();
