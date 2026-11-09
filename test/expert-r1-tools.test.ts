import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// Expert round 1: agent-facing text names only tools a default install has, and MCP read results fit host output limits.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer, DEFAULT_TOOLS, LIST_BODY_CHARS } from "../src/mcp-server-core.js";
import { SNIPPET_BODY } from "../src/snippet.js";
import { runHook } from "../src/hook.js";

const withTools = async <T>(v: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const prev = process.env.MONOMEM_TOOLS;
  if (v === undefined) delete process.env.MONOMEM_TOOLS;
  else process.env.MONOMEM_TOOLS = v;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.MONOMEM_TOOLS;
    else process.env.MONOMEM_TOOLS = prev;
  }
};

describe("agent-facing text names only default tools", () => {
  test("every backticked tool name in the snippet is a default tool", () => {
    const names = [...SNIPPET_BODY.matchAll(/`([a-z]+_[a-z_]+)`/g)].map((m) => m[1]);
    assert.ok(names.length >= 3, names.join());
    for (const n of names) assert.ok(DEFAULT_TOOLS.includes(n), `${n} is not in DEFAULT_TOOLS`);
    assert.match(SNIPPET_BODY, /`state_search` \(add mode: "relevant" to pass the whole question\)/);
  });

  test("file-context with default tools says state_read id=N and never names memory_get", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-r1-fctx-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      const n = s.create({ title: "Fixed rounding in tax.ts", body: "round half even" }, { kind: "observation", sessionId: "old", obsType: "bugfix" });
      s.captureDb().prepare("INSERT INTO note_files (note_id, path, action) VALUES (?, ?, 'changed')").run(n.id, "src/tax.ts");
      s.close();
      const payload = JSON.stringify({ session_id: "s1", cwd: "C:/work/app", tool_name: "Read", tool_input: { file_path: "C:/work/app/src/tax.ts" } });
      const out = await withTools(undefined, () => runHook("file-context", payload, { dbPath: db, dataDir: dir, env: {} }));
      const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
      assert.match(ctx, /Open any with state_read id=N/);
      assert.doesNotMatch(ctx, /memory_get/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("catch_up's description names task_get / memory_since / memory_ack only when they are enabled", async () => {
    const describe = async (tools: string | undefined): Promise<string> =>
      withTools(tools, async () => {
        const store = new Store(":memory:");
        const server = createMcpServer(store, "admin", {} as never, { label: "t", authed: true });
        const [c, s] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "t", version: "1" });
        await Promise.all([client.connect(c), server.connect(s)]);
        const d = (await client.listTools()).tools.find((t) => t.name === "catch_up")!.description!;
        await client.close();
        store.close();
        return d;
      });
    const dflt = await describe(undefined);
    assert.doesNotMatch(dflt, /task_get|memory_since|memory_ack/);
    assert.match(dflt, /ack_token` back \(on your next catch_up\)/);
    const all = await describe("all");
    assert.match(all, /task_get for the rest/);
    assert.match(all, /next catch_up, memory_since or memory_ack/);
  });
});

describe("MCP read results sized for host output limits", () => {
  test("5 notes of ~54KB: state_search stays under 25k chars; state_read returns the whole body; state_write omits it", async () => {
    const store = new Store(":memory:");
    try {
      const server = createMcpServer(store, "admin", {} as never, { label: "t", authed: true });
      const [c, s] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([client.connect(c), server.connect(s)]);
      const big = ("deploy pipeline notes " + "lorem ipsum dolor sit amet ".repeat(2000)).slice(0, 54_000);
      let id = 0;
      for (let i = 0; i < 5; i++) {
        const w = (await client.callTool({ name: "state_write", arguments: { title: `Deploy pipeline ${i}`, body: big } })) as { content: Array<{ text: string }> };
        const t = w.content[0].text;
        const j = JSON.parse(t.slice(t.indexOf("{")));
        assert.equal(j.note.body, undefined, "state_write echoes no body");
        assert.ok(j.note.id && j.note.rev && j.note.title && j.note.written_by !== undefined && j.note.created_at);
        id = j.note.id;
      }
      const r = (await client.callTool({ name: "state_search", arguments: { query: "deploy pipeline" } })) as { content: Array<{ text: string }> };
      const total = r.content.reduce((n, b) => n + b.text.length, 0);
      assert.ok(total < 25_000, `state_search result is ${total} chars`);
      const t = r.content[0].text;
      const hits = JSON.parse(t.slice(t.indexOf("{"))).results as Array<{ body: string; body_truncated?: boolean; body_chars?: number }>;
      assert.equal(hits.length, 5);
      for (const h of hits) {
        assert.equal(h.body.length, LIST_BODY_CHARS);
        assert.equal(h.body_truncated, true);
        assert.equal(h.body_chars, 54_000);
      }
      assert.ok(!t.includes("\n  "), "compact JSON, no indent");
      const l = (await client.callTool({ name: "state_list", arguments: {} })) as { content: Array<{ text: string }> };
      const lt = l.content[0].text;
      assert.ok((JSON.parse(lt.slice(lt.indexOf("{"))).notes as Array<{ body_truncated?: boolean }>).every((n) => n.body_truncated === true));
      const one = (await client.callTool({ name: "state_read", arguments: { id } })) as { content: Array<{ text: string }> };
      const ot = one.content[0].text;
      // Round 2: state_read returns the body in parts of max_chars (default 40000); next_offset fetches the rest.
      const first = JSON.parse(ot.slice(ot.indexOf("{"))).note;
      assert.equal(first.body.length, 40_000);
      assert.equal(first.body_chars, 54_000);
      const rest = (await client.callTool({ name: "state_read", arguments: { id, offset: first.next_offset } })) as { content: Array<{ text: string }> };
      const rt = JSON.parse(rest.content[0].text.slice(rest.content[0].text.indexOf("{"))).note;
      assert.equal(first.body + rt.body, big, "the two parts are the whole body");
      assert.equal(rt.next_offset, undefined);
      const small = (await client.callTool({ name: "state_write", arguments: { title: "short", body: "tiny" } })) as { content: Array<{ text: string }> };
      void small;
      const r2 = (await client.callTool({ name: "state_search", arguments: { query: "short" } })) as { content: Array<{ text: string }> };
      const sh = JSON.parse(r2.content[0].text.slice(r2.content[0].text.indexOf("{"))).results.find((x: { title: string }) => x.title === "short");
      assert.equal(sh.body, "tiny");
      assert.equal(sh.body_truncated, undefined, "a short body is not marked");
      await client.close();
    } finally {
      store.close();
    }
  });

  test("memory_supersede_preview returns one JSON block with ok, token, expires_at and warning", async () => {
    const store = new Store(":memory:");
    try {
      const server = createMcpServer(store, "admin", {} as never, { label: "t", authed: true });
      const [c, s] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([client.connect(c), server.connect(s)]);
      const old = store.create({ title: "Rotation rule", body: "Rotates on Friday" });
      const p = (await client.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [old.id], new_title: "Rotation rule", new_body: "Monday" } })) as { content: Array<{ text: string }> };
      assert.equal(p.content.length, 1);
      const j = JSON.parse(p.content[0].text.slice(p.content[0].text.indexOf("{")));
      assert.equal(j.ok, true);
      assert.ok(j.token && j.expires_at);
      assert.match(j.warning, /ARE YOU SURE YOU WANT TO REPLACE THIS\?/);
      await client.close();
    } finally {
      store.close();
    }
  });
});
