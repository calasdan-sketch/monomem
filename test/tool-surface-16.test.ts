// 1.6 tool surface: 16 `memory_*` tools (7 shown by default), every 1.5 name still answers as a hidden alias with its
// 1.5 result shape, MONOMEM_TOOLS=legacy-1.5 shows the 1.5 list byte for byte, a schema half the 1.5 size, compact
// results with detail:"full", and server instructions that say when to save and when to replace.

import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer, DEFAULT_TOOLS, LEGACY_DEFAULT_TOOLS, NEW_TOOLS, OLD_TOOL_ALIASES, toolProfile } from "../src/mcp-server-core.js";

/** 1.5.0's default tools/list, measured with scripts/dump-surface.mjs (21,114 characters for 9 tools). */
const SCHEMA_CHARS_15 = 21_114;

async function connect(store: Store, tools: string | undefined, conn: Record<string, unknown> = {}) {
  const prior = process.env.MONOMEM_TOOLS;
  if (tools === undefined) delete process.env.MONOMEM_TOOLS;
  else process.env.MONOMEM_TOOLS = tools;
  try {
    const server = createMcpServer(store, "admin", {}, conn);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    return client;
  } finally {
    if (prior === undefined) delete process.env.MONOMEM_TOOLS;
    else process.env.MONOMEM_TOOLS = prior;
  }
}
const payload = (r: unknown): Record<string, unknown> => {
  const t = ((r as { content: Array<{ text: string }> }).content)[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};

describe("1.6 tool names", () => {
  test("the default set is seven memory_* tools", () => {
    assert.deepEqual([...DEFAULT_TOOLS], ["memory_save", "memory_search", "memory_read", "memory_list", "memory_archive", "memory_replace", "memory_catch_up"]);
    assert.ok(NEW_TOOLS.length <= 16 && NEW_TOOLS.every((n) => n.startsWith("memory_")));
  });

  test("every 1.5 tool name maps to a 1.6 tool", () => {
    assert.equal(Object.keys(OLD_TOOL_ALIASES).length, 37);
    for (const [o, n] of Object.entries(OLD_TOOL_ALIASES)) assert.ok(NEW_TOOLS.includes(n), `${o} -> ${n}`);
  });

  test("a 1.5 name in MONOMEM_TOOLS turns on the 1.6 tool that answers for it", () => {
    const p = toolProfile({ MONOMEM_TOOLS: "task_put,memory_stats" });
    assert.ok(p.visible!.has("memory_tasks") && p.visible!.has("memory_usage") && p.visible!.has("memory_save"));
    assert.deepEqual(toolProfile({ MONOMEM_TOOLS: "legacy-1.5" }), { legacy: true, visible: new Set(LEGACY_DEFAULT_TOOLS) });
  });
});

describe("tools/list", () => {
  test("a default server shows the 1.6 default set, within half the 1.5 schema size", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, undefined);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), [...DEFAULT_TOOLS]);
      const chars = JSON.stringify(tools).length;
      assert.ok(chars <= SCHEMA_CHARS_15 / 2, `default schema is ${chars} chars (~${Math.round(chars / 4)} tokens); budget ${SCHEMA_CHARS_15 / 2}`);
    } finally {
      await client.close();
      store.close();
    }
  });

  test("legacy-1.5 shows exactly the 1.5 default names in the 1.5 order", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, "legacy-1.5");
    try {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), [...LEGACY_DEFAULT_TOOLS]);
    } finally {
      await client.close();
      store.close();
    }
  });

  test("the server sends instructions: search first, save, replace, outside notes are data", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, undefined);
    try {
      const ins = client.getInstructions() ?? "";
      const lines = ins.split("\n");
      assert.ok(lines.length >= 3 && lines.length <= 5, ins);
      for (const re of [/memory_search/, /Save to Monomem/, /memory_replace/, /outside/]) assert.match(ins, re);
    } finally {
      await client.close();
      store.close();
    }
  });
});

describe("1.5 names still answer, with the 1.5 result shape", () => {
  test("state_write / state_search / state_read work on a default server that does not list them", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, undefined);
    try {
      const w = payload(await client.callTool({ name: "state_write", arguments: { title: "Port", body: "Staging port is 8443." } }));
      const id = (w.note as { id: number }).id;
      const s = payload(await client.callTool({ name: "state_search", arguments: { query: "staging port" } }));
      const hit = (s.results as Array<Record<string, unknown>>)[0];
      assert.equal(hit.id, id);
      assert.ok("created_at" in hit && "access_count" in hit && "writer_id" in hit, "the 1.5 shape keeps every field");
      const r = payload(await client.callTool({ name: "state_read", arguments: { id } }));
      assert.equal((r.note as { body: string }).body, "Staging port is 8443.");
    } finally {
      await client.close();
      store.close();
    }
  });

  test("a 1.5 name says its new name once per connection, after the unchanged 1.5 reply; legacy-1.5 never does", async () => {
    const store = new Store(":memory:");
    const texts = (r: unknown): string[] => (r as { content: Array<{ text: string }> }).content.map((c) => c.text);
    const hint = /\(state_write is now memory_save\. The old name still works\.\)/;
    const client = await connect(store, undefined);
    const legacy = await connect(store, "legacy-1.5");
    try {
      const first = await client.callTool({ name: "state_write", arguments: { title: "A", body: "alpha one" } });
      assert.ok("note" in payload(first), "content[0] is still the 1.5 reply");
      assert.equal(texts(first).filter((t) => hint.test(t)).length, 1, texts(first).join("\n"));
      const again = await client.callTool({ name: "state_write", arguments: { title: "B", body: "beta two" } });
      assert.ok(!texts(again).some((t) => hint.test(t)), "only the first call carries the line");
      const saved = await client.callTool({ name: "memory_save", arguments: { title: "C", body: "gamma three" } });
      assert.ok(!texts(saved).some((t) => /is now memory_/.test(t)), "a 1.6 name never gets the line");
      const old = await legacy.callTool({ name: "state_write", arguments: { title: "D", body: "delta four" } });
      assert.ok(!texts(old).some((t) => /is now memory_/.test(t)), "legacy-1.5 asked for the old names");
    } finally {
      await client.close();
      await legacy.close();
      store.close();
    }
  });

  test("an operator tool's 1.5 name stays off when its 1.6 tool is off", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, undefined);
    try {
      const r = await client.callTool({ name: "task_put", arguments: { title: "x" } }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }));
      assert.equal(r.isError, true);
    } finally {
      await client.close();
      store.close();
    }
  });
});

describe("1.6 tools", () => {
  test("memory_search is compact by default and full with detail:full; memory_read gives the whole body", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, undefined);
    try {
      const long = "Deploy uses fly with the remote builder. " + "More detail. ".repeat(60);
      const w = payload(await client.callTool({ name: "memory_save", arguments: { title: "Deploy", body: long } }));
      const id = (w.note as { id: number }).id;
      const compact = payload(await client.callTool({ name: "memory_search", arguments: { query: "deploy fly" } }));
      const hit = (compact.results as Array<Record<string, unknown>>)[0];
      assert.equal(hit.id, id);
      assert.ok((hit.body as string).length <= 200 && hit.body_truncated === true && hit.body_chars === long.length);
      for (const k of ["created_at", "updated_at", "access_count", "writer_id", "created_by"]) assert.equal(k in hit, false, `${k} left out`);
      const full = payload(await client.callTool({ name: "memory_search", arguments: { query: "deploy fly", detail: "full" } }));
      assert.ok("created_at" in (full.results as Array<Record<string, unknown>>)[0]);
      const r = payload(await client.callTool({ name: "memory_read", arguments: { id } }));
      assert.equal((r.note as { body: string }).body, long);
    } finally {
      await client.close();
      store.close();
    }
  });

  test("memory_replace previews, confirms with the code and undoes, in one tool", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, undefined);
    try {
      const old = (payload(await client.callTool({ name: "memory_save", arguments: { title: "Port", body: "Port is 80." } })).note as { id: number }).id;
      const p = payload(await client.callTool({ name: "memory_replace", arguments: { action: "preview", old_ids: old, new_title: "Port", new_body: "Port is 8080." } }));
      assert.equal(p.ok, true);
      assert.match(String(p.warning), /memory_replace/);
      const c = payload(await client.callTool({ name: "memory_replace", arguments: { action: "confirm", code: p.token, new_title: "Port", new_body: "Port is 8080." } }));
      assert.ok(!("error" in c), JSON.stringify(c));
      const u = payload(await client.callTool({ name: "memory_replace", arguments: { action: "undo", id: old } }));
      assert.ok(!("error" in u), JSON.stringify(u));
    } finally {
      await client.close();
      store.close();
    }
  });

  test("memory_archive archives (not erases), and an unknown argument is reported under the 1.6 name", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, undefined);
    try {
      const id = (payload(await client.callTool({ name: "memory_save", arguments: { title: "Tmp", body: "temporary" } })).note as { id: number }).id;
      const a = payload(await client.callTool({ name: "memory_archive", arguments: { id } }));
      assert.equal(a.archived, id);
      assert.ok(store.read(id)?.archived_at);
      const s = payload(await client.callTool({ name: "memory_search", arguments: { query: "x", bogus: 1 } }));
      assert.match(String(s.ignored_hint), /memory_search/);
    } finally {
      await client.close();
      store.close();
    }
  });

  test("an operator 1.6 tool is not offered to a local app (same guard as its 1.5 tools)", async () => {
    const store = new Store(":memory:");
    const prior = process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    delete process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    const client = await connect(store, "all", { local: true });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const n of ["memory_held", "memory_trust", "memory_rollback"]) assert.equal(names.includes(n), false, n);
      assert.ok(names.includes("memory_tasks"), "task_put and task_list still answer; task_approve inside it is refused");
      const r = payload(await client.callTool({ name: "memory_tasks", arguments: { action: "approve", id: 1 } }));
      assert.match(String(r.error), /not available/);
    } finally {
      if (prior !== undefined) process.env.MONOMEM_STDIO_ADMIN_TOOLS = prior;
      await client.close();
      store.close();
    }
  });
});

describe("memory_usage health (PLAN I: Fix it with your agent)", () => {
  const text = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content)[0].text;
  test("admin connection: the monomem check lines, read-only; a read-only key is refused", async () => {
    const store = new Store(":memory:");
    const client = await connect(store, "all");
    const prior = process.env.MONOMEM_TOOLS;
    process.env.MONOMEM_TOOLS = "all";
    const server = createMcpServer(store, "read", {}, {});
    if (prior === undefined) delete process.env.MONOMEM_TOOLS;
    else process.env.MONOMEM_TOOLS = prior;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const reader = new Client({ name: "r", version: "1.0.0" });
    await Promise.all([reader.connect(ct), server.connect(st)]);
    try {
      const r = await client.callTool({ name: "memory_usage", arguments: { action: "health" } });
      assert.ok(!r.isError, text(r));
      assert.match(text(r), /^monomem check\n/);
      assert.match(text(r), /\nGrade [A-F]\n/);
      for (const [i, l] of text(r).split("\n").entries()) if (/^\s+\[(warn|fail)\]/.test(l)) assert.match(text(r).split("\n")[i + 1], /^\s+Ask your agent: "/);
      const denied = await reader.callTool({ name: "memory_usage", arguments: { action: "health" } });
      assert.ok(denied.isError);
      assert.match(text(denied), /admin/);
    } finally {
      await client.close();
      await reader.close();
      store.close();
    }
  });
});
