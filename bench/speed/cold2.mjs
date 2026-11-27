// node cold2.mjs <script> <reps> [dbdir]: spawn `node script` as an MCP stdio server, time to initialize response. Optional populated home copied fresh each rep.
import { mkdtempSync, rmSync, cpSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
import { McpClient } from "../../../r6-bench/mcpclient.mjs";
const script = process.argv[2], REPS = +process.argv[3], src = process.argv[4]; const a = [];
const d = mkdtempSync(join(tmpdir(), "mm-c2-")); if (src) cpSync(src, d, { recursive: true }); // one copy, reused: later starts see a warm, already-migrated home
for (let i = 0; i < REPS; i++) {
  const env = { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log"), MONOMEM_CLIENT: "cold", ...(process.env.NO_CC ? { NO_CC: "1" } : {}) };
  const t = performance.now(); const c = new McpClient("node", [script], env); await c.init(); a.push(performance.now() - t);
  c.p.stdin.end(); await new Promise((r) => c.p.on("exit", r))
}
try { rmSync(d, { recursive: true, force: true }); } catch {}
const s = [...a].sort((x, y) => x - y); console.log(JSON.stringify({ script: script.split(/[\/]/).pop(), med: +s[s.length >> 1].toFixed(0), min: +s[0].toFixed(0), max: +s.at(-1).toFixed(0) }));
