import { McpClient } from "../../../r6-bench/mcpclient.mjs";
const [root, d, prof] = process.argv.slice(2);
const env = { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: d + "/a.log", MONOMEM_CLIENT: "cold" };
for (let i = 0; i < 2; i++) { const t = performance.now(); const c = new McpClient("node", ["--cpu-prof", "--cpu-prof-dir=" + prof + i, `${root}/dist/src/mcp-stdio.js`], env); await c.init(); console.log("init ms", (performance.now() - t).toFixed(0)); await new Promise((r) => setTimeout(r, 1500)); c.p.stdin.end(); await new Promise((r) => c.p.on("exit", r)); }
