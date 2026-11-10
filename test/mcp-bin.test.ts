// `monomem-mcp`: a launcher that runs one bare command with no arguments (a catalog entry) must get the stdio MCP
// server, not the HTTP server and dashboard that `monomem` with no arguments starts.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the monomem-mcp bin starts the stdio MCP server with no arguments", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { bin: Record<string, string> };
  assert.equal(pkg.bin["monomem-mcp"], "dist/src/mcp-stdio.js");
  const bin = join(ROOT, pkg.bin["monomem-mcp"]);
  assert.ok(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node"), "npm needs the shebang to link the bin on macOS/Linux");

  const home = mkdtempSync(join(tmpdir(), "om-mcp-bin-"));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [bin], // no subcommand, exactly as a bare-command launcher runs it
    env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, MONOMEM_HOME: join(home, "data") },
    stderr: "ignore",
  });
  const c = new Client({ name: "t", version: "1" });
  await c.connect(t);
  try {
    const names = (await c.listTools()).tools.map((x) => x.name);
    assert.ok(names.includes("state_write") && names.includes("state_search"), names.join(","));
    await c.callTool({ name: "state_write", arguments: { title: "bin check", body: "written through monomem-mcp" } });
    const res = (await c.callTool({ name: "state_search", arguments: { query: "monomem-mcp" } })) as { content: Array<{ text: string }> };
    assert.match(res.content[0].text, /bin check/);
  } finally {
    await c.close();
    rmSync(home, { recursive: true, force: true });
  }
});
