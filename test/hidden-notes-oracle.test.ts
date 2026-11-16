// 1.5.0 R1-12: a note the caller cannot see (other namespace, above its sensitivity ceiling, written by a distrusted writer)
// answers exactly like a note that does not exist, on every by-id route; counts include visible notes only; a reader of a
// child never learns a parent id it cannot read through derived_from; deleting a note leaves no link/confirm orphans.
// Ported from the security review's r5-hidden-oracle PoC. (Timing is out of scope; SECURITY.md says so.)
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { disputeFields } from "../src/facts.js";

const raw = (s: Store): any => (s as any).db;
afterEach(() => setProcessWriter(""));

function seed() {
  const store = new Store(":memory:");
  setProcessWriter("cli");
  const otherNs = store.create({ namespace: "secret", title: "zebra other ns", body: "zebra" });
  const priv = store.create({ namespace: "pa", title: "zebra private", body: "zebra", sensitivity: "private" });
  const distrusted = store.create({ namespace: "pa", title: "zebra by evil", body: "zebra" });
  raw(store).prepare("UPDATE notes SET written_by='evil' WHERE id=?").run(distrusted.id);
  store.distrustAdd("pa", "evil");
  const visible = store.create({ namespace: "pa", title: "zebra visible", body: "zebra" });
  setProcessWriter("");
  return { store, otherNs, priv, distrusted, visible };
}
const P = { token: "p".repeat(40), scope: "write" as const, label: "pinned-app", namespace: "pa", max_sensitivity: "internal" as const };
const MISSING = 99999;
const norm = (status: number, text: string): string => `${status} ${text.replace(/[0-9]+/g, "N")}`;

describe("R1-12 hidden notes answer like missing ones", () => {
  test("the by-id REST routes: status and body equal a nonexistent id", async () => {
    const { store, otherNs, priv, distrusted } = seed();
    const http = createApiServer(store, [P]);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const call = async (m: string, path: string, b?: unknown) => {
      const r = await fetch(base + path, { method: m, headers: { authorization: `Bearer ${P.token}`, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return norm(r.status, await r.text());
    };
    const routes: Array<[string, (id: number) => string, ((id: number) => unknown) | undefined]> = [
      ["GET", (id) => `/notes/${id}`, undefined],
      ["PUT", (id) => `/notes/${id}`, () => ({ confidence: 0.5 })],
      ["DELETE", (id) => `/notes/${id}`, undefined],
      ["POST", (id) => `/notes/${id}/confirm`, () => ({ source: "x.example" })],
      ["POST", (id) => `/notes/${id}/archive`, () => ({})],
      ["POST", (id) => `/notes/${id}/restore`, () => ({})],
      ["GET", (id) => `/notes/${id}/history`, undefined],
      ["POST", (id) => `/notes/${id}/history/restore`, () => ({ version: 1 })],
      ["GET", (id) => `/tasks/${id}`, undefined],
      ["POST", (id) => `/tasks/${id}/claim`, () => ({ owner: "x" })],
      ["PUT", (id) => `/tasks/${id}`, () => ({ owner: "x" })],
      ["POST", () => `/notes`, (id) => ({ title: "t", body: "b", derived_from: [id] })],
      ["POST", () => `/get`, (id) => ({ ids: [id] })],
      // final-security SF1: an empty or too-long reason must not be checked before visibility
      ["POST", (id) => `/notes/${id}/flag`, () => ({ reason: "" })],
      ["POST", (id) => `/notes/${id}/flag`, () => ({ reason: "x".repeat(201) })],
    ];
    try {
      for (const [m, p, b] of routes) {
        const miss = await call(m, p(MISSING), b?.(MISSING));
        for (const [name, n] of [["other namespace", otherNs], ["above ceiling", priv], ["distrusted writer", distrusted]] as const) {
          const hid = await call(m, p(n.id), b?.(n.id));
          assert.equal(hid, miss, `${m} ${p(0)} (${name})`);
        }
      }
    } finally {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      store.close();
    }
  });

  test("the by-id MCP tools: the same", async () => {
    const { store, otherNs, priv, distrusted } = seed();
    const server = createMcpServer(store, "write", { tools: "all", namespace: "pa" } as any, { label: "pinned-app", authed: true, maxSensitivity: "internal" } as any);
    const [c1, c2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c1), server.connect(c2)]);
    const tools: Array<[string, (id: number) => Record<string, unknown>]> = [
      ["state_read", (id) => ({ id })],
      ["state_write", (id) => ({ id, confidence: 0.5 })],
      ["memory_get", (id) => ({ ids: [id] })],
      ["memory_history", (id) => ({ id })],
      ["task_get", (id) => ({ id })],
      ["task_claim", (id) => ({ id, owner: "x" })],
      ["memory_timeline", (id) => ({ anchor: id })],
      ["memory_flag", (id) => ({ id, reason: "" })],
      ["memory_flag", (id) => ({ id, reason: "x".repeat(201) })],
    ];
    const out = async (name: string, args: Record<string, unknown>): Promise<string> => norm(0, JSON.stringify(await client.callTool({ name, arguments: args })));
    try {
      for (const [name, args] of tools) {
        const miss = await out(name, args(MISSING));
        for (const n of [otherNs, priv, distrusted]) assert.equal(await out(name, args(n.id)), miss, `${name} on hidden #${n.id}`);
      }
    } finally {
      await client.close();
      store.close();
    }
  });

  test("search, stats and catch-up count visible notes only; session start respects the ceiling", async () => {
    const { store, visible } = seed();
    const http = createApiServer(store, [P]);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const get = async (p: string): Promise<any> => (await fetch(base + p, { headers: { authorization: `Bearer ${P.token}` } })).json();
    try {
      const search = await get("/search?q=zebra");
      assert.deepEqual((search.results ?? search.notes).map((n: any) => n.id), [visible.id]);
      assert.equal(search.total ?? 1, 1);
      assert.equal((await get("/stats")).totalNotes, 1);
      const cu = JSON.stringify(await get("/catch-up?consumer=z"));
      assert.ok(!/zebra private|zebra by evil|zebra other ns/.test(cu), cu);
    } finally {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      store.close();
    }
  });
});

describe("R1-12 derived_from names only parents the reader may read", () => {
  test("a child in pa derived from a parent in pb shows no parent id to a reader confined to pa", () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    const parent = s.create({ namespace: "pb", title: "parent in pb", body: "b" });
    const child = s.create({ namespace: "pa", title: "child in pa", body: "b", derived_from: [parent.id] } as any);
    setProcessWriter("");
    assert.deepEqual((s.read(child.id) as any).derived_from, [parent.id], "the unrestricted reader sees the link");
    const seen = actorStore.run({ label: "pinned", authed: true, readable: ["pa"] } as any, () => s.read(child.id) as any);
    assert.ok(seen, "the child itself is readable");
    assert.ok(!JSON.stringify(seen).includes(`${parent.id}`) || !(seen.derived_from ?? []).includes(parent.id), `derived_from leaked the parent id: ${JSON.stringify(seen.derived_from)}`);
    assert.deepEqual(seen.derived_from ?? [], []);
    s.close();
  });
});

describe("R2-01 ceiling-leak probe: a dispute marker never shows a note the reader cannot see", () => {
  // Two worlds that differ only in whether the private note (above the reader's ceiling) disputes the visible one.
  function world(disputes: boolean) {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const visible = store.create({ namespace: "pa", title: "deploy zebra", body: "zebra", tags: ["fact:deploy_target=fly"] });
    setProcessWriter("stdio:other");
    store.create({ namespace: "pa", title: "private zebra", body: "zebra", sensitivity: "private", tags: disputes ? ["fact:deploy_target=render"] : ["x"] });
    setProcessWriter("");
    return { store, visible };
  }
  test("REST and MCP reads answer the same with and without the hidden disputing note", async () => {
    const replies: string[][] = [];
    for (const disputes of [true, false]) {
      const { store, visible } = world(disputes);
      const http = createApiServer(store, [P]);
      await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
      const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const get = async (p: string) => norm(0, await (await fetch(base + p, { headers: { authorization: `Bearer ${P.token}` } })).text());
      const server = createMcpServer(store, "write", { tools: "all", namespace: "pa" } as any, { label: "pinned-app", authed: true, maxSensitivity: "internal" } as any);
      const [c1, c2] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([client.connect(c1), server.connect(c2)]);
      const mcp = async (name: string, args: Record<string, unknown>) => norm(0, JSON.stringify(await client.callTool({ name, arguments: args })));
      try {
        const out = [await get(`/notes/${visible.id}`), await get(`/search?q=zebra`), await get(`/notes`), await mcp("state_read", { id: visible.id }), await mcp("state_list", {}), await mcp("memory_get", { ids: [visible.id] })];
        for (const o of out) assert.ok(!/disputed|render/i.test(o), `marker leaked a hidden note: ${o.slice(0, 300)}`);
        replies.push(out.map((o) => o.replace(/writer_id[^,]*/g, "")));  // the server id is random per store
      } finally {
        await client.close();
        http.closeAllConnections();
        await new Promise<void>((r) => http.close(() => r()));
        store.close();
      }
    }
    assert.deepEqual(replies[0], replies[1]);
  });

  test("control: an unrestricted reader does see the marker", () => {
    const { store, visible } = world(true);
    assert.match(JSON.stringify(disputeFields(store, store.read(visible.id)!)), /render/);
    store.close();
  });
});

describe("GAP-OBSOLETE-UNREPLACED probe: a hidden note never restates (reorders or labels) a visible one", () => {
  // Two worlds that differ only in whether a newer note by the SAME writer, above the reader's ceiling, restates the visible one.
  function world(restates: boolean) {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const visible = store.create({ namespace: "pa", title: "zebra build server", body: "The zebra build server is kalmuth.", tags: ["fact:build_server=kalmuth"] });
    // A different writer's note on the same words: never a restater, it only makes the result list longer.
    setProcessWriter("stdio:other");
    const other = store.create({ namespace: "pa", title: "zebra build server notes", body: "The zebra build server notes, longer text about other things." });
    setProcessWriter("cli");
    const hidden = store.create({
      namespace: "pa",
      title: "zebra build server moved",
      body: "Update: the zebra build server is now prendal.",
      sensitivity: "private",
      tags: restates ? ["fact:build_server=prendal"] : ["x"],
    });
    setProcessWriter("");
    // Written in this order, a day apart, so the hidden note is the newer one.
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    for (const [id, d] of [[visible.id, 3], [other.id, 2], [hidden.id, 1]] as const) raw(store).prepare("UPDATE notes SET created_at = ?, updated_at = ?, content_at = ? WHERE id = ?").run(day(d), day(d), day(d), id);
    return { store, visible, hidden };
  }
  test("REST and MCP searches answer the same with and without the hidden restating note", async () => {
    const replies: string[][] = [];
    for (const restates of [true, false]) {
      const { store } = world(restates);
      const http = createApiServer(store, [P]);
      await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
      const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const req = async (m: string, p: string, b?: unknown) =>
        norm(0, await (await fetch(base + p, { method: m, headers: { authorization: `Bearer ${P.token}`, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) })).text());
      const server = createMcpServer(store, "write", { tools: "all", namespace: "pa" } as any, { label: "pinned-app", authed: true, maxSensitivity: "internal" } as any);
      const [c1, c2] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([client.connect(c1), server.connect(c2)]);
      const mcp = async (name: string, args: Record<string, unknown>) => norm(0, JSON.stringify(await client.callTool({ name, arguments: args })));
      try {
        const out = [
          await req("GET", "/search?q=zebra%20build%20server"),
          await req("GET", "/search?q=zebra%20build%20server&explain=1"),
          await req("POST", "/relevant", { message: "which build server does zebra use?" }),
          await mcp("state_search", { query: "zebra build server" }),
          await mcp("state_search", { query: "zebra build server", explain: true }),
          await mcp("state_relevant", { message: "which build server does zebra use?" }),
        ];
        for (const o of out) assert.ok(!/restated|prendal|Kept behind/i.test(o), `a hidden note restated a visible one: ${o.slice(0, 300)}`);
        replies.push(out.map((o) => o.replace(/writer_id[^,]*/g, "").replace(/"(last_accessed|access_count)[^,]*/g, "")));
      } finally {
        await client.close();
        http.closeAllConnections();
        await new Promise<void>((r) => http.close(() => r()));
        store.close();
      }
    }
    assert.deepEqual(replies[0], replies[1]);
  });

  test("control: an unrestricted reader does see the restatement", async () => {
    const { store, visible, hidden } = world(true);
    const { runSearch } = await import("../src/search-service.js");
    const r = (await runSearch(store, "zebra build server", { mode: "keyword" })) as Array<{ id: number; restated_by?: number }>;
    assert.equal(r.find((n) => n.id === visible.id)?.restated_by, hidden.id);
    store.close();
  });
});

describe("R1-12 deleting a note leaves no orphans", () => {
  test("note_links (either column) and confirmations of a deleted note are removed", () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    const a = s.create({ title: "parent", body: "b" });
    const b = s.create({ title: "child", body: "b", derived_from: [a.id] } as any);
    setProcessWriter("");
    raw(s).prepare("INSERT INTO confirmations (note_id, note_rev, at, by, by_authed, kind, source, source_key, reason) VALUES (?, 1, 'now', 'x', 1, 'corroborated', 's', 'k', '')").run(a.id);
    assert.equal(raw(s).prepare("SELECT COUNT(*) AS n FROM note_links").get().n, 1);
    raw(s).prepare("DELETE FROM notes WHERE id = ?").run(a.id);
    assert.equal(raw(s).prepare("SELECT COUNT(*) AS n FROM note_links").get().n, 0, "link to the deleted parent is gone");
    assert.equal(raw(s).prepare("SELECT COUNT(*) AS n FROM confirmations WHERE note_id = ?").get(a.id).n, 0);
    raw(s).prepare("INSERT INTO note_links (note_id, derived_from, added_at, added_by) VALUES (?, ?, 'now', 'x')").run(b.id, 12345);
    raw(s).prepare("DELETE FROM notes WHERE id = ?").run(b.id);
    assert.equal(raw(s).prepare("SELECT COUNT(*) AS n FROM note_links").get().n, 0, "link from the deleted child is gone");
    s.close();
  });
});
