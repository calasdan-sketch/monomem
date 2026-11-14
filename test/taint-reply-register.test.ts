// 1.5.0 R1-05: every reply that hands a connection an unconfirmed note marks the reader (via:memory, and read_it on a confirm),
// not only the read routes/tools. Ported from the security review's PoCs r1, r1b and r2.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { setProcessWriter } from "../src/actor.js";

const VIA = "obs.origin:via:memory";
const body = (r: any): string => r.content?.[0]?.text ?? "";
const json = (r: any): any => {
  const t = body(r);
  return JSON.parse(t.slice(t.indexOf("{")));
};
afterEach(() => setProcessWriter(""));

async function mcp(store: Store, conn: Record<string, unknown> = { local: true }) {
  const server = createMcpServer(store, "admin", { tools: "all" }, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

describe("R1-05 MCP: any tool reply that carries an unconfirmed note marks the connection", () => {
  const probes: Array<[string, (c: Client, noteId: number, taskId: number) => Promise<unknown>]> = [
    ["state_write metadata edit of the tainted note", (c, n) => c.callTool({ name: "state_write", arguments: { id: n, tags: ["x"] } })],
    ["task_claim", (c, _n, t) => c.callTool({ name: "task_claim", arguments: { id: t, owner: "me" } })],
    ["task_put update", (c, _n, t) => c.callTool({ name: "task_put", arguments: { id: t, owner: "me2" } })],
    ["task_get", (c, _n, t) => c.callTool({ name: "task_get", arguments: { id: t } })],
    ["task_list", (c) => c.callTool({ name: "task_list", arguments: {} })],
    ["memory_history", (c, n) => c.callTool({ name: "memory_history", arguments: { id: n } })],
  ];
  for (const [label, probe] of probes) {
    test(label, async () => {
      const store = new Store(":memory:");
      setProcessWriter("stdio");
      const web = await mcp(store, { local: true, readsOutside: true });
      const note = json(await web.callTool({ name: "state_write", arguments: { title: "vendor page", body: "SECRET-PAYLOAD-NOTE" } })).note;
      const task = json(await web.callTool({ name: "task_put", arguments: { title: "deploy", notes: "SECRET-PAYLOAD-TASK", next_step: "SECRET-PAYLOAD-NEXT" } })).task;
      const c = await mcp(store, { local: true });
      const reply = body(await probe(c, note.id, task.id));
      assert.match(reply, /SECRET-PAYLOAD/, "the probe really handed the agent the unconfirmed text");
      const w = json(await c.callTool({ name: "state_write", arguments: { title: `copy via ${label}`, body: "laundered copy" } })).note;
      assert.ok(w.tags.includes(VIA), `next write is marked: ${w.tags.join()}`);
    });
  }
});

describe("R1-05 REST: PUT /notes/:id and POST /tasks/:id/claim mark the token and trigger read_it", () => {
  test("PUT /notes/:id {confidence} echoes the note: next write is via:memory and the confirm is refused read_it", async () => {
    const store = new Store(":memory:");
    setProcessWriter("server");
    const A = { token: "a".repeat(40), scope: "write" as const, label: "browser-bot", reads_outside: true };
    const B = { token: "b".repeat(40), scope: "write" as const, label: "worker-bot" };
    const http = createApiServer(store, [A, B]);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const call = async (tok: string, method: string, path: string, b?: unknown) => {
      const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return (await r.json()) as any;
    };
    try {
      const n = (await call(A.token, "POST", "/notes", { title: "vendor page", body: "SECRET-PAYLOAD" })).note;
      const t = (await call(A.token, "POST", "/tasks", { title: "deploy", notes: "SECRET-PAYLOAD-TASK", next_step: "x" })).task;
      const put = await call(B.token, "PUT", `/notes/${n.id}`, { confidence: 0.5 });
      assert.match(JSON.stringify(put), /SECRET-PAYLOAD/);
      const bw = (await call(B.token, "POST", "/notes", { title: "B copy", body: "x" })).note;
      assert.ok(bw.tags.includes(VIA), bw.tags.join());
      const cf = await call(B.token, "POST", `/notes/${n.id}/confirm`, { source: "https://docs.vendor.example" });
      assert.equal(cf.counted, false);
      assert.equal(cf.reason, "read_it");
      const cl = await call(B.token, "POST", `/tasks/${t.id}/claim`, { owner: "B" });
      assert.match(JSON.stringify(cl), /SECRET-PAYLOAD-TASK/);
      const cf2 = await call(B.token, "POST", `/notes/${t.id}/confirm`, { source: "https://ci.example" });
      assert.equal(cf2.reason, "read_it", JSON.stringify(cf2));
    } finally {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      store.close();
    }
  });
});
