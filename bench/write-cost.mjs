// Does one write stay cheap on a big namespace? Moved here from test/v110-fixes.test.ts (1.6.0 Phase 0): a fixed
// "< 25 ms" is a speed claim, not a correctness check, and on a loaded Windows or macOS CI runner it measured the runner.
// CI runs this on the Linux offline job, where the number means something.
//
//   npm run build
//   node bench/write-cost.mjs
//
// 1.1.0-rc measured ~70-110 ms per write here (whole-namespace re-select + re-tokenize); the indexed path is a few ms.
// Fills an in-memory store with 2,000 notes, then times 7 creates and 7 updates and gates the medians.
// Exit 1 if either median is at or over GATE_MS. Nothing on disk except a throwaway data folder, deleted afterwards.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GATE_MS = 25;
for (const k of Object.keys(process.env)) if (k.startsWith("MONOMEM_") || k.startsWith("ONEMEMORY_")) delete process.env[k];
const home = mkdtempSync(join(tmpdir(), "monomem-write-cost-"));
process.env.MONOMEM_HOME = home; // before store.js loads config.js: never the real data folder
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { Store } = await import(pathToFileURL(join(root, "dist", "src", "store.js")).href);

const words = Array.from({ length: 3000 }, (_, i) => `w${i.toString(36)}q`);
let seed = 3;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const gen = (n) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(" ");
const median = (fn) => {
  const ts = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return ts.sort((x, y) => x - y)[3];
};

const s = new Store(":memory:");
let code = 0;
try {
  for (let i = 0; i < 2000; i++) s.create({ title: gen(6), body: gen(60) }, { skipEdges: true });
  s.create({ title: gen(6), body: gen(60) }); // first write builds the index
  const createMs = median(() => s.create({ title: gen(6), body: gen(60) }));
  let id = 10;
  const updateMs = median(() => s.update(id++, { body: gen(60) }));
  const pass = createMs < GATE_MS && updateMs < GATE_MS;
  console.log(JSON.stringify({ notes: 2000, createMedianMs: +createMs.toFixed(1), updateMedianMs: +updateMs.toFixed(1), gateMs: GATE_MS, pass }));
  if (!pass) code = 1;
} finally {
  s.close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(code);
