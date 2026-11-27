// node mkdb.mjs <root> <N> <outDir> : build a populated home (notes + 768-dim vectors). Zipf text as r6-bench/latency.mjs.
import { mkdirSync, rmSync } from "node:fs"; import { join } from "node:path";
const root = process.argv[2], N = +process.argv[3], d = process.argv[4], DIM = 768;
rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true });
Object.assign(process.env, { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log") });
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(7), vr = rng(3);
const vocab = Array.from({ length: 5000 }, (_, i) => { let w = "", n = i + 1; do { w += "bcdfghklmnprstvz"[n % 16] + "aeiou"[(n >> 4) % 5]; n = Math.floor(n / 16); } while (n); return w + (i % 97); });
const zipf = () => vocab[Math.min(4999, Math.floor(Math.pow(r(), 2.2) * 5000))];
const { Store } = await import(`file:///${root}/dist/src/store.js`);
const store = new Store(join(d, "state.db"));
const CH = 2000;
for (let s = 0; s < N; s += CH) store.transaction(() => { for (let i = s; i < Math.min(N, s + CH); i++) {
  const body = Array.from({ length: 40 + Math.floor(r() * 40) }, zipf).join(" ");
  const n = store.create({ title: Array.from({ length: 3 }, zipf).join(" ") + " " + i, body }, { skipEdges: true, lint: "none" });
  const v = new Float32Array(DIM); let nn = 0; for (let k = 0; k < DIM; k++) { v[k] = vr() - 0.5; nn += v[k] * v[k]; } nn = Math.sqrt(nn); for (let k = 0; k < DIM; k++) v[k] /= nn;
  store.setVector(n.id, v, "bench"); } });
console.log("done", N, store.vectorCount()); store.close();
