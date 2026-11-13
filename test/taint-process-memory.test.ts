// 1.4.0 taint, signal 2: a connection that read an unconfirmed note marks what it writes next `obs.origin:via:memory`
// (laundering outside content through memory itself, which hooks never see).
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { setProcessWriter } from "../src/actor.js";

async function connect(store: Store, conn = {}) {
  const server = createMcpServer(store, "admin", { tools: "all" }, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}
const json = (r: any) => {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};

afterEach(() => setProcessWriter(""));

describe("taint through memory", () => {
  test("stdio: a search that returns an unconfirmed note marks the next write via:memory; another process is not marked", async () => {
    const store = new Store(":memory:");
    setProcessWriter("stdio");
    store.create({ title: "vendor page notes", body: "acme price 40", outside: true });
    const reader = await connect(store, { local: true });
    const r = json(await reader.callTool({ name: "state_search", arguments: { query: "acme" } }));
    assert.equal(r.results[0].unconfirmed, true, "the search result carries the flag");
    assert.equal(r.results[0].unconfirmed_label, "[unconfirmed - from outside content]");
    const w = json(await reader.callTool({ name: "state_write", arguments: { title: "pricing summary", body: "acme costs 40" } }));
    assert.ok(w.note.tags.includes("obs.origin:via:memory"), JSON.stringify(w.note.tags));
    const fresh = await connect(store, { local: true });
    const w2 = json(await fresh.callTool({ name: "state_write", arguments: { title: "unrelated", body: "lunch" } }));
    assert.ok(!(w2.note.tags ?? []).includes("obs.origin:via:memory"), "a process that read nothing is not marked");
    await reader.close();
    await fresh.close();
    store.close();
  });

  test("a read of a confirmed or clean note does not mark the reader", async () => {
    const store = new Store(":memory:");
    setProcessWriter("stdio");
    const n = store.create({ title: "vendor page notes", body: "acme price 40", outside: true });
    setProcessWriter("cli");
    store.confirm(n.id, { source: "called the vendor" });
    setProcessWriter("stdio");
    const c = await connect(store, { local: true });
    json(await c.callTool({ name: "state_read", arguments: { id: n.id } }));
    const w = json(await c.callTool({ name: "state_write", arguments: { title: "x", body: "y" } }));
    assert.ok(!(w.note.tags ?? []).includes("obs.origin:via:memory"));
    await c.close();
    store.close();
  });

  test("REST: a token that read an unconfirmed note is marked on its next write (per token, across requests)", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const tokens = [
      { token: "reader-token-aaaaaaaaaaaaaaaaaaaaaaaa", scope: "write" as const, label: "reader-bot" },
      { token: "other-token-bbbbbbbbbbbbbbbbbbbbbbbbbb", scope: "write" as const, label: "other-bot" },
    ];
    const http = createApiServer(store, tokens);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const call = async (tok: string, method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as any };
    };
    try {
      const made = await call(tokens[1].token, "POST", "/notes", { title: "page notes", body: "zebra pricing page", outside: true });
      assert.equal(made.status, 201);
      assert.equal(made.json.note.unconfirmed, true);
      const s = await call(tokens[0].token, "GET", "/search?q=zebra");
      assert.equal(s.json.results[0].unconfirmed, true);
      const w = await call(tokens[0].token, "POST", "/notes", { title: "clean summary", body: "zebra costs 40" });
      assert.ok(w.json.note.tags.includes("obs.origin:via:memory"), JSON.stringify(w.json.note.tags));
    } finally {
      await new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      });
      store.close();
    }
  });
});
