// Child process for the two-process tests (not a test itself): `node cas-worker.js <db> <note id> <tag> <n> <go file>`.
// Waits for the go file, then writes n blind updates to one note and prints the acknowledged revs as JSON.
import { existsSync } from "node:fs";
import { Store } from "../src/store.js";

const [dbPath, idArg, tag, nArg, goFile] = process.argv.slice(2);
const store = new Store(dbPath);
const acks: Array<{ body: string; rev: number }> = [];
const deadline = Date.now() + 20_000;
while (!existsSync(goFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
for (let i = 0; i < Number(nArg); i++) {
  const body = `${tag}-${i}`;
  const r = store.update(Number(idArg), { body });
  if (r) acks.push({ body, rev: r.rev });
}
store.close();
process.stdout.write(JSON.stringify(acks));
