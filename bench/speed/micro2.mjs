// node micro2.mjs <root> <dbdir> [reps] [what] : copy the populated home to a fresh temp dir, then time each op REPS times (median of per-rep medians).
import { mkdtempSync, rmSync, cpSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const root = process.argv[2], src = process.argv[3], REPS = +(process.argv[4] ?? 5), WHAT = (process.argv[5] ?? "all").split(",");
const d = mkdtempSync(join(tmpdir(), "mm-m2-")); cpSync(src, d, { recursive: true });
Object.assign(process.env, { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log"), MONOMEM_EMBEDDINGS: "on", MONOMEM_EMBED_URL: "http://127.0.0.1:9/none" });
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(11);
const vocab = Array.from({ length: 5000 }, (_, i) => { let w = "", n = i + 1; do { w += "bcdfghklmnprstvz"[n % 16] + "aeiou"[(n >> 4) % 5]; n = Math.floor(n / 16); } while (n); return w + (i % 97); });
const zipf = () => vocab[Math.min(4999, Math.floor(Math.pow(r(), 2.2) * 5000))];
const mk = (i) => { const body = Array.from({ length: 40 + Math.floor(r() * 40) }, zipf).join(" "); return { title: Array.from({ length: 3 }, zipf).join(" ") + " w" + i, body }; };
const med = (x) => { const s = [...x].sort((a, b) => a - b); return s[s.length >> 1]; };
const out = { db: src.split(/[\/]/).pop(), root: root.split("/").pop() };
const { Store } = await import(`file:///${root}/dist/src/store.js`);
const ss = await import(`file:///${root}/dist/src/search-service.js`);
let t = performance.now(); const store = new Store(join(d, "state.db")); out.openMs = +(performance.now() - t).toFixed(1);
const qs = Array.from({ length: 40 }, () => zipf() + " " + zipf());
const vr = rng(5); const qv = new Float32Array(768).map(() => vr() - 0.5);
const timeIt = (f, n) => { const a = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(i); a.push(performance.now() - t); } return med(a); };
const timeA = async (f, n) => { const a = []; for (let i = 0; i < n; i++) { const t = performance.now(); await f(i); a.push(performance.now() - t); } return med(a); };
const rep = async (name, f, n = 20) => { const m = []; for (let k = 0; k < REPS; k++) m.push(await timeA(f, n)); out[name] = `${med(m).toFixed(2)} [${Math.min(...m).toFixed(2)}-${Math.max(...m).toFixed(2)}]`; };
const on = (w) => WHAT.includes("all") || WHAT.includes(w);
if (on("kw")) { await timeA((i) => ss.runSearch(store, qs[i % 40], { mode: "keyword", limit: 10 }), 10); await rep("keyword", (i) => ss.runSearch(store, qs[i % 40], { mode: "keyword", limit: 10 }), 40); }
if (on("scan")) { store.semanticSearch(qv, { limit: 100 }); await rep("semScan", () => store.semanticSearch(qv, { limit: 100 }), 10); }
if (on("hyb")) {
  const rf = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ embedding: Array.from(qv) }] }), { status: 200 });
  await rep("hybridNoNet", (i) => ss.runSearch(store, qs[i % 40], { mode: "hybrid", limit: 10 }), 10); globalThis.fetch = rf;
}
if (on("write")) { let wi = 0; await rep("writeDefault", () => store.create(mk(wi++), {}), 20); }
console.log(JSON.stringify(out)); store.close(); rmSync(d, { recursive: true, force: true });
