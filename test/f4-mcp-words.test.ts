// F4 lane mcp-words (round 4 ease N3-N10 + LOWs): memory_save arguments, "held" vs "unconfirmed (from outside)", session
// start, setup --undo --dry-run, activity attribution and small wording fixes.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";

const json = (r: any): any => {
  const t: string = r.content?.[0]?.text ?? "";
  return JSON.parse(t.slice(t.indexOf("{")));
};

async function connect(s: Store, label = "agent"): Promise<Client> {
  const server = createMcpServer(s, "write", { tools: "all" }, { label, authed: true });
  const [c, t] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: label, version: "1" });
  await Promise.all([client.connect(c), server.connect(t)]);
  return client;
}

test("ease N3: memory_save with evidence does not report evidence as ignored", async () => {
  const s = new Store(":memory:");
  const c = await connect(s);
  try {
    for (const evidence of [[{ kind: "file", ref: "src/app.ts:1" }], []]) {
      const r = json(await c.callTool({ name: "memory_save", arguments: { title: "Port seen", body: "Port is 8443", evidence } }));
      assert.equal(r.ignored_arguments, undefined, JSON.stringify(r));
      assert.equal(r.ignored_hint, undefined, JSON.stringify(r));
      assert.ok(s.read(r.note.id)!.basis, "evidence was used");
    }
    // a real unknown argument is still reported, under the 1.6 name
    const u = json(await c.callTool({ name: "memory_save", arguments: { title: "x", body: "y", colour: "red" } }));
    assert.deepEqual(u.ignored_arguments, ["colour"]);
    assert.match(u.ignored_hint, /memory_save/);
  } finally {
    await c.close();
    s.close();
  }
});

test("ease N4: memory_save lists claims and derived_from in tools/list, and derived_from is not reported ignored", async () => {
  const s = new Store(":memory:");
  const c = await connect(s);
  try {
    const { tools } = await c.listTools();
    const save = tools.find((t) => t.name === "memory_save")!;
    const props = Object.keys((save.inputSchema as { properties: object }).properties);
    assert.ok(props.includes("claims"), props.join(","));
    assert.ok(props.includes("derived_from"), props.join(","));
    const a = json(await c.callTool({ name: "memory_save", arguments: { title: "base", body: "the base note" } })).note;
    const b = json(await c.callTool({ name: "memory_save", arguments: { title: "built", body: "built on base", derived_from: [a.id] } }));
    assert.equal(b.ignored_arguments, undefined, JSON.stringify(b));
  } finally {
    await c.close();
    s.close();
  }
});

test("ease N5: an import says unconfirmed (from outside), not held, and never 'until you read them'", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runForeignImport } = await import("../src/foreign-import.js");
  const root = mkdtempSync(join(tmpdir(), "om-f4-n5-"));
  try {
    const p = join(root, "mem0.json");
    writeFileSync(p, JSON.stringify({ results: [{ id: "a1", memory: "Prefers dark mode", user_id: "avery" }] }));
    const lines: string[] = [];
    const io = { interactive: false, out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l), ask: async () => "" };
    const e = { home: root, env: {} as NodeJS.ProcessEnv, cwd: root };
    assert.equal(await runForeignImport(e, io, { from: "mem0", path: p, dryRun: false, yes: true, dbPath: join(root, "db", "state.db") }), 0);
    const out = lines.join("\n");
    assert.match(out, /unconfirmed \(from outside\) until you confirm them/);
    assert.match(out, /monomem confirm <id>/);
    assert.doesNotMatch(out, /\bheld \(marked|until you read them/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
