// Measures the reply size of a 20-hit memory_search / memory_list over a real stdio server, per detail level.
// Usage: node bench/index-mode-tokens.mjs   (uses a fresh temp store; never your own). Tokens are estimated as chars/4.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "cli.js");
const home = mkdtempSync(join(tmpdir(), "monomem-index-"));
const t = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env: { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home }, stderr: "ignore" });
const c = new Client({ name: "index-bench", version: "1" });
await c.connect(t);
for (let i = 0; i < 30; i++) {
  await c.callTool({ name: "memory_save", arguments: { title: `Decision ${i}: deploy service ${i} with the pnpm workspace`, body: `We decided that the deploy pipeline for service ${i} uses the pnpm workspace with caching enabled and a staged rollout. `.repeat(8), tags: ["deploy"] } });
}
const size = async (name, args) => (await c.callTool({ name, arguments: args })).content[0].text;
const rows = [];
for (const [name, base] of [["memory_search", { query: "deploy pipeline pnpm", limit: 20 }], ["memory_list", { limit: 20 }]]) {
  for (const detail of [undefined, "index", "full"]) {
    const text = await size(name, { ...base, ...(detail ? { detail } : {}) });
    rows.push({ tool: name, detail: detail ?? "compact(default)", chars: text.length, approx_tokens: Math.round(text.length / 4), per_hit: Math.round(text.length / 4 / 20) });
  }
}
console.table(rows);
if (process.env.SHOW) console.log(await size(process.env.TOOL ?? "memory_search", { query: "deploy", limit: 2, detail: process.env.SHOW }));
await c.close();
