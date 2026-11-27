import { mkdtempSync, cpSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const root = process.argv[2], src = process.argv[3]; const d = mkdtempSync(join(tmpdir(), "mm-op-")); cpSync(src, d, { recursive: true });
Object.assign(process.env, { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log") });
let t = performance.now(); const { Store } = await import(`file:///${root}/dist/src/store.js`); const core = await import(`file:///${root}/dist/src/mcp-server-core.js`); const imp = performance.now() - t;
const r = [];
for (let i = 0; i < 4; i++) { t = performance.now(); const s = new Store(join(d, "state.db")); const o = performance.now() - t; t = performance.now(); core.stdioSweep(s); r.push([o.toFixed(0), (performance.now() - t).toFixed(0)]); s.close(); }
console.log(root.split("/").pop(), "import", imp.toFixed(0), "open/sweep", JSON.stringify(r));
