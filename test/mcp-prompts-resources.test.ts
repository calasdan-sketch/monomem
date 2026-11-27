// MCP prompts and resources: they exist, read notes only through the tools' own gate, add no tool, advertise minimal
// capabilities and keep stdout pure JSON-RPC. Visibility against hidden notes is in scope-matrix.test.ts.
import "./setup-env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer, DEFAULT_TOOLS } from "../src/mcp-server-core.js";

async function connect(store: Store, tools: "all" | readonly string[] = DEFAULT_TOOLS): Promise<Client> {
  const server = createMcpServer(store, "admin", { namespace: "work", tools }, { label: "t", authed: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(a), server.connect(b)]);
  return client;
}

describe("MCP prompts and resources", () => {
  let store: Store;
  let id = 0;
  before(() => {
    store = new Store(":memory:");
    id = store.create({ namespace: "work", title: "Deploy uses port 8080", body: "Behind the proxy. Reason: the firewall." }).id;
  });
  after(() => store.close());

  test("capabilities are minimal: prompts and resources are empty objects, no listChanged or subscribe", async () => {
    const c = await connect(store);
    const caps = c.getServerCapabilities()!;
    assert.deepEqual(caps.prompts, {});
    assert.deepEqual(caps.resources, {});
    await c.close();
  });

  test("four prompts, each text names the tools to call and carries no note text", async () => {
    const c = await connect(store);
    const names = (await c.listPrompts()).prompts.map((p) => p.name).sort();
    assert.deepEqual(names, ["handoff", "recap", "remember-decision", "what-changed"]);
    for (const n of names) {
      const r = await c.getPrompt({ name: n, arguments: n === "remember-decision" ? { decision: "use port 8080", reason: "proxy" } : {} });
      const text = (r.messages[0].content as { text: string }).text;
      assert.match(text, /memory_/);
      assert.ok(!text.includes("Deploy uses port 8080"), "a prompt never embeds a note");
    }
    const rd = await c.getPrompt({ name: "remember-decision", arguments: { decision: "use port 8080" } });
    assert.match((rd.messages[0].content as { text: string }).text, /ask me for one/);
    await assert.rejects(() => c.getPrompt({ name: "remember-decision", arguments: {} }));
    await c.close();
  });

  test("resources: recent as an index, a note by id, a bad id refused; held only when the tool is offered", async () => {
    const c = await connect(store);
    assert.deepEqual((await c.listResources()).resources.map((r) => r.uri).sort(), ["monomem://recent"]);
    assert.deepEqual((await c.listResourceTemplates()).resourceTemplates.map((r) => r.uriTemplate), ["monomem://notes/{id}"]);
    const recent = (await c.readResource({ uri: "monomem://recent" })).contents[0] as { text: string };
    assert.match(recent.text, /Deploy uses port 8080/);
    assert.ok(!recent.text.includes("Behind the proxy"), "an index line, not the body");
    const one = (await c.readResource({ uri: `monomem://notes/${id}` })).contents[0] as { text: string };
    assert.match(one.text, /Behind the proxy/);
    await assert.rejects(() => c.readResource({ uri: "monomem://notes/abc" }));
    await assert.rejects(() => c.readResource({ uri: "monomem://notes/9999" }), /no note/);
    await c.close();
    const all = await connect(store, "all");
    assert.ok((await all.listResources()).resources.some((r) => r.uri === "monomem://held"));
    const held = (await all.readResource({ uri: "monomem://held" })).contents[0] as { text: string };
    assert.doesNotThrow(() => JSON.parse(held.text.slice(held.text.indexOf("{"))));
    await all.close();
  });

  test("the tool list is untouched: the default seven, no prompt or resource among them", async () => {
    const c = await connect(store);
    const tools = (await c.listTools()).tools.map((t) => t.name);
    assert.deepEqual(tools, ["memory_save", "memory_search", "memory_read", "memory_list", "memory_archive", "memory_replace", "memory_catch_up"]);
    await c.close();
  });
});

describe("stdio: stdout stays pure JSON-RPC with prompts and resources on", () => {
  test("every stdout line is a JSON-RPC message", async () => {
    const home = mkdtempSync(join(tmpdir(), "pr-stdio-"));
    const cli = join(import.meta.dirname, "..", "src", "cli.js");
    const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", MONOMEM_HOME: home, ONEMEMORY_HOME: home, MONOMEM_AUDIT_LOG: join(home, "audit.log") };
    const child = spawn(process.execPath, [cli, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const send = (o: object): void => void child.stdin.write(JSON.stringify(o) + "\n");
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "prompts/list" });
      send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
      send({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "monomem://recent" } });
      const t0 = Date.now();
      while (!/"id":4/.test(out) && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 100));
      const lines = out.split("\n").filter(Boolean);
      assert.ok(lines.length >= 4, out);
      for (const l of lines) assert.equal((JSON.parse(l) as { jsonrpc: string }).jsonrpc, "2.0");
      const init = JSON.parse(lines[0]) as { result: { capabilities: Record<string, unknown> } };
      assert.deepEqual(init.result.capabilities.prompts, {});
    } finally {
      child.kill();
      await new Promise((r) => setTimeout(r, 300));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
