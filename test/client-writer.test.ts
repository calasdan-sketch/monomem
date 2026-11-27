// Round 3, 08-F6: without MONOMEM_CLIENT the stdio writer is stdio:<app> from the MCP handshake, so each app has its own flood budget.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writerFromClientName } from "../src/mcp/client-writer.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

test("client names become tidy stdio:<app> labels; junk and operator labels are respected", () => {
  assert.equal(writerFromClientName("Claude Code", {}), "stdio:claude-code");
  assert.equal(writerFromClientName("claude-ai", {}), "stdio:claude-ai");
  assert.equal(writerFromClientName("  Cursor (VS Code) ", {}), "stdio:cursor-vs-code");
  assert.equal(writerFromClientName("***", {}), null);
  assert.equal(writerFromClientName(undefined, {}), null);
  assert.equal(writerFromClientName("a".repeat(80), {})!.length, "stdio:".length + 40);
  assert.equal(writerFromClientName("Claude Code", { MONOMEM_CLIENT: "codex" }), null, "MONOMEM_CLIENT wins");
});

function lastJson(r: unknown): { note?: { written_by: string }; error?: string } {
  const c = r as { content: Array<{ text: string }> };
  const t = c.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{\"")));
}

test("two apps on one store get separate writers, and the flood guard counts each one on its own", async () => {
  const home = mkdtempSync(join(tmpdir(), "mm-cw-"));
  const env = { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home, MONOMEM_FLOOD_WRITES_PER_HOUR: "3" } as Record<string, string>;
  delete env.MONOMEM_CLIENT;
  const connect = async (name: string): Promise<Client> => {
    const c = new Client({ name, version: "1" });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "ignore" }));
    return c;
  };
  const a = await connect("Alpha App");
  const b = await connect("Beta App");
  try {
    const save = (c: Client, n: number) => c.callTool({ name: "state_write", arguments: { title: `distinct note ${n} ${Math.random().toString(36).slice(2)}`, body: `body ${n} unique ${Math.random()}` } });
    assert.equal(lastJson(await save(a, 0)).note?.written_by, "stdio:alpha-app");
    assert.equal(lastJson(await save(b, 0)).note?.written_by, "stdio:beta-app");
    for (let i = 1; i < 3; i++) await save(a, i); // alpha: 3 writes, at the limit
    const refused = JSON.stringify(await save(a, 9));
    assert.match(refused, /paused by the flood guard/);
    assert.equal(lastJson(await save(b, 1)).note?.written_by, "stdio:beta-app", "beta is not paused by alpha's writes");
  } finally {
    await a.close();
    await b.close();
    rmSync(home, { recursive: true, force: true });
  }
});
