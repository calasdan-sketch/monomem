// node micro3.mjs <root> <dbdir> <reps> : end-to-end hybrid search with the REAL embedding endpoint (Ollama nomic-embed-text), distinct queries (no query-vector cache hits).
import { mkdtempSync, rmSync, cpSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const root = process.argv[2], src = process.argv[3], REPS = +(process.argv[4] ?? 5);
const d = mkdtempSync(join(tmpdir(), "mm-m3-")); cpSync(src, d, { recursive: true });
Object.assign(process.env, { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log"), MONOMEM_EMBEDDINGS: "on", MONOMEM_EMBED_URL: "http://localhost:11434/v1/embeddings", MONOMEM_EMBED_MODEL: "nomic-embed-text" });
const { Store } = await import(`file:///${root}/dist/src/store.js`); const ss = await import(`file:///${root}/dist/src/search-service.js`);
const store = new Store(join(d, "state.db"));
const med = (x) => [...x].sort((a, b) => a - b)[x.length >> 1];
const vocab = Array.from({ length: 200 }, (_, i) => "w" + i.toString(36) + "x");
await ss.runSearch(store, "warm up query alpha", { mode: "hybrid", limit: 10 });
const meds = []; let n = 0;
for (let k = 0; k < REPS; k++) { const a = []; for (let i = 0; i < 15; i++) { const q = `${vocab[(n * 7) % 200]} ${vocab[(n * 13 + 3) % 200]} topic ${n++}`; const t = performance.now(); await ss.runSearch(store, q, { mode: "hybrid", limit: 10 }); a.push(performance.now() - t); } meds.push(med(a)); }
console.log(JSON.stringify({ db: src.split(/[\/]/).pop(), root: root.split("/").pop(), hybridRealEmbed: `${med(meds).toFixed(1)} [${Math.min(...meds).toFixed(1)}-${Math.max(...meds).toFixed(1)}]` }));
store.close(); rmSync(d, { recursive: true, force: true });
