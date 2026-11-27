// node micro.mjs <root> <N> [reps]  -- in-process timings of keyword / semantic-scan / hybrid-minus-embed / write at N notes.
// Synthetic Zipf notes (same generator as r6-bench/latency.mjs), 768-dim random unit vectors (no network). Fresh temp homes.
import { mkdtempSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const root = process.argv[2], N = +process.argv[3], REPS = +(process.argv[4] ?? 5), DIM = 768;
const d = mkdtempSync(join(tmpdir(), "mm-speed-"));
Object.assign(process.env, { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log"), MONOMEM_EMBEDDINGS: "on" });
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(7);
const vocab = Array.from({ length: 5000 }, (_, i) => { let w = "", n = i + 1; do { w += "bcdfghklmnprstvz"[n % 16] + "aeiou"[(n >> 4) % 5]; n = Math.floor(n / 16); } while (n); return w + (i % 97); });
const zipf = () => vocab[Math.min(4999, Math.floor(Math.pow(r(), 2.2) * 5000))];
const mk = (i) => { const body = Array.from({ length: 40 + Math.floor(r() * 40) }, zipf).join(" "); return { title: Array.from({ length: 3 }, zipf).join(" ") + " " + i, body, words: body.split(" ") }; };
const med = (x) => { const s = [...x].sort((a, b) => a - b); return s[s.length >> 1]; };
const fmt = (x) => `${med(x).toFixed(2)} [${Math.min(...x).toFixed(2)}-${Math.max(...x).toFixed(2)}]`;
const { Store } = await import(`file:///${root}/dist/src/store.js`);
const ss = await import(`file:///${root}/dist/src/search-service.js`);
const store = new Store(join(d, "state.db"));
const vr = rng(3); const rv = () => { const v = new Float32Array(DIM); let n = 0; for (let i = 0; i < DIM; i++) { v[i] = vr() - 0.5; n += v[i] * v[i]; } n = Math.sqrt(n); for (let i = 0; i < DIM; i++) v[i] /= n; return v; };
const docs = []; const t0 = performance.now();
store.transaction(() => { for (let i = 0; i < N; i++) { const x = mk(i); if (docs.length < 400) docs.push(x); const n = store.create({ title: x.title, body: x.body }, { skipEdges: true, lint: "none" }); store.setVector(n.id, rv(), "bench"); } });
console.error(`fill ${N}: ${((performance.now() - t0) / 1000).toFixed(1)}s`);
const qs = Array.from({ length: 40 }, () => { const x = docs[Math.floor(vr() * docs.length)]; return x.words[Math.floor(vr() * x.words.length)] + " " + x.words[Math.floor(vr() * x.words.length)]; });
const qv = rv();
const out = { root, N };
const timeIt = async (f, n = 40) => { const a = []; for (let i = 0; i < n; i++) { const t = performance.now(); await f(i); a.push(performance.now() - t); } return a; };
const rep = async (name, f, n) => { const meds = []; for (let k = 0; k < REPS; k++) meds.push(med(await timeIt(f, n))); out[name] = fmt(meds); };
await timeIt((i) => ss.runSearch(store, qs[i % 40], { mode: "keyword", limit: 10 }), 10); // warm
await rep("keywordSearch", (i) => ss.runSearch(store, qs[i % 40], { mode: "keyword", limit: 10 }));
await rep("semanticScan", () => store.semanticSearch(qv, { limit: 100 }), 20);
// hybrid with embedding cached/faked: stub fetch to return qv instantly so we time everything except the HTTP round trip
const realFetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ embedding: Array.from(qv) }] }), { status: 200 });
await rep("hybridNoNet", (i) => ss.runSearch(store, qs[i % 40], { mode: "hybrid", limit: 10 }));
globalThis.fetch = realFetch;
// write: real default path (lint + edges on) vs bulk
let wi = N; await rep("writeDefault", () => store.create(mk(wi++), {}), 20);
console.log(JSON.stringify(out));
store.close(); rmSync(d, { recursive: true, force: true });
