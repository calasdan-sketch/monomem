// node cold.mjs <root> [reps] [prof]  -- spawn mcp-stdio, time to initialize response. Fresh home each rep.
import { mkdtempSync, rmSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
import { McpClient } from "../../../r6-bench/mcpclient.mjs";
const root = process.argv[2], REPS = +(process.argv[3] ?? 5), prof = process.argv[4];
const a = [];
for (let i = 0; i < REPS; i++) {
  const d = mkdtempSync(join(tmpdir(), "mm-cold-"));
  const env = { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log"), MONOMEM_CLIENT: "cold" };
  const args = prof ? ["--cpu-prof", "--cpu-prof-dir=" + prof, `${root}/dist/src/mcp-stdio.js`] : [`${root}/dist/src/mcp-stdio.js`];
  const t = performance.now(); const c = new McpClient("node", args, env); await c.init(); a.push(performance.now() - t); c.p.stdin.end(); await new Promise((r) => c.p.on("exit", r));
  await new Promise((r) => setTimeout(r, 500)); try { rmSync(d, { recursive: true, force: true }); } catch {}
}
const s = [...a].sort((x, y) => x - y); console.log(JSON.stringify({ medMs: +s[s.length >> 1].toFixed(0), min: +s[0].toFixed(0), max: +s.at(-1).toFixed(0), all: a.map((x) => +x.toFixed(0)) }));
