// Prints tools/list size over stdio for the default, all, and all+admin profiles (the numbers the docs quote).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "cli.js");
for (const [label, extra] of [["default", {}], ["all", { MONOMEM_TOOLS: "all" }], ["admin", { MONOMEM_TOOLS: "all", MONOMEM_STDIO_ADMIN_TOOLS: "1" }]]) {
  const env = { ...process.env, ...extra };
  if (label === "default") { delete env.MONOMEM_TOOLS; delete env.MONOMEM_STDIO_ADMIN_TOOLS; }
  const c = new Client({ name: "size", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "ignore" }));
  const { tools } = await c.listTools();
  console.log(label, tools.length, JSON.stringify(tools).length);
  await c.close();
}
