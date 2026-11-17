// Approve-first namespaces: every agent write waits in the quarantine queue until an operator approves it.
// The operator is the local `monomem` CLI (writer marker `cli`); MCP, REST (any token) and library callers are held.
// Also: state_search mode "relevant" does what state_relevant does, and state_relevant left the default tool set.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, QuarantinedError } from "../src/store.js";
import { createMcpServer, DEFAULT_TOOLS } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { setProcessWriter } from "../src/actor.js";
import { supersedePreview } from "../src/supersede.js";

async function connect(store: Store, conn = {}) {
  const server = createMcpServer(store, "admin", {}, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}
const parse = (r: any) => JSON.parse(r.content[0].text);
// Read results carry the untrusted-data banner before the JSON.
const parseRead = (r: any) => JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("{")));
const titles = (store: Store, namespace: string) => store.list({ namespace }).notes.map((n) => n.title);

afterEach(() => setProcessWriter(""));

describe("approve-first namespaces", () => {
  test("an agent write over MCP is held with the approval reason, not stored", async () => {
    const store = new Store(":memory:");
    store.setApproveFirst("team", true);
    setProcessWriter("stdio");
    const c = await connect(store, { local: true });
    const r: any = await c.callTool({ name: "state_write", arguments: { namespace: "team", title: "deploy on fridays", body: "ok" } });
    assert.ok(!r.isError);
    const out = parse(r);
    assert.ok(out.quarantined, "held, not stored");
    assert.match(out.quarantined.message, /namespace requires approval/);
    assert.deepEqual(out.quarantined.reasons, [{ category: "approval", label: "namespace requires approval", field: "namespace" }]);
    assert.deepEqual(titles(store, "team"), []);
    const q = store.listQuarantine();
    assert.equal(q.length, 1);
    assert.equal(q[0].namespace, "team");
    assert.equal(q[0].reasons[0].label, "namespace requires approval");
    await c.close();
    store.close();
  });

  test("an agent update is held; a confidence-only patch is not", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const n = store.create({ namespace: "team", title: "port", body: "8080" });
    store.setApproveFirst("team", true);
    setProcessWriter("stdio");
    assert.throws(() => store.update(n.id, { body: "9090" }), QuarantinedError);
    assert.equal(store.read(n.id)?.body, "8080");
    assert.equal(store.update(n.id, { confidence: 0.5 })?.confidence, 0.5);
    // Moving a note OUT of an approve-first namespace is held too.
    assert.throws(() => store.update(n.id, { namespace: "elsewhere" }), QuarantinedError);
    // ...and moving one IN.
    setProcessWriter("cli");
    const m = store.create({ namespace: "other", title: "m" });
    setProcessWriter("stdio");
    assert.throws(() => store.update(m.id, { namespace: "team" }), QuarantinedError);
    assert.equal(store.read(m.id)?.namespace, "other");
    store.close();
  });

  test("a CLI (operator) write is not held", () => {
    const store = new Store(":memory:");
    store.setApproveFirst("team", true);
    setProcessWriter("cli");
    const n = store.create({ namespace: "team", title: "by the operator" });
    assert.equal(n.written_by, "cli");
    assert.ok(store.update(n.id, { body: "edited" }));
    assert.equal(store.listQuarantine().length, 0);
    store.close();
  });

  test("an agent cannot forget, restore or replace notes there; the operator can", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const n = store.create({ namespace: "team", title: "deploy rule", body: "fridays only" });
    store.setApproveFirst("team", true);
    setProcessWriter("stdio");
    const c = await connect(store, { local: true });
    const del: any = await c.callTool({ name: "state_delete", arguments: { id: n.id } });
    assert.ok(del.isError, "state_delete refused");
    assert.match(del.content[0].text, /approve-first/);
    const prev: any = await c.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [n.id], new_title: "deploy rule", new_body: "any day" } });
    assert.ok(prev.isError, "supersede preview refused");
    assert.match(prev.content[0].text, /approve-first/);
    assert.throws(() => store.archive(n.id), /approve-first/);
    assert.equal(store.read(n.id)?.archived_at ?? null, null, "still live");
    setProcessWriter("cli");
    assert.ok(store.archive(n.id)?.archived_at, "operator archive works");
    setProcessWriter("stdio");
    assert.throws(() => store.restore(n.id), /approve-first/);
    setProcessWriter("cli");
    assert.equal(store.restore(n.id)?.archived_at ?? null, null, "operator restore works");
    await c.close();
    store.close();
  });

  test("an agent cannot undo an operator's replacement or set a forget date there", () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const bad = store.create({ namespace: "team", title: "deploy rule", body: "poisoned" });
    const good = store.create({ namespace: "team", title: "deploy rule v2", body: "fridays only" });
    store.supersedeCommit({ oldIds: [bad.id], oldRevs: [bad.rev], newId: good.id, actor: "cli", nonce: "t", expiresMs: Date.now() + 60_000 });
    store.setApproveFirst("team", true);
    setProcessWriter("stdio");
    assert.throws(() => store.supersedeUndo(bad.id, "stdio"), /approve-first/);
    assert.ok(store.read(bad.id)?.superseded_by, "still replaced");
    assert.throws(() => store.update(good.id, { forget_after: 0.000001 }), /approve-first/);
    assert.equal(store.sweepExpired(Date.now() + 86_400_000), 0, "nothing to sweep");
    assert.doesNotThrow(() => store.update(good.id, { forget_after: 0 }), "keep-forever stays allowed");
    setProcessWriter("cli");
    assert.ok(store.supersedeUndo(bad.id, "cli"), "operator undo works");
    store.close();
  });

  test("approve stores it with the real writer; reject drops it", async () => {
    const store = new Store(":memory:");
    store.setApproveFirst("team", true);
    setProcessWriter("stdio");
    const c = await connect(store, { local: true });
    const a = parse(await c.callTool({ name: "state_write", arguments: { namespace: "team", title: "keep me" } }));
    const b = parse(await c.callTool({ name: "state_write", arguments: { namespace: "team", title: "drop me" } }));
    setProcessWriter("cli");
    const note = store.approveQuarantine(a.quarantined.id);
    assert.equal(note.title, "keep me");
    assert.equal(note.written_by, "stdio", "the agent stays the writer, not the approving operator");
    assert.ok(store.rejectQuarantine(b.quarantined.id));
    assert.deepEqual(titles(store, "team"), ["keep me"]);
    assert.equal(store.listQuarantine().length, 0);
    await c.close();
    store.close();
  });

  test("turning it off stops holding; other namespaces were never held", () => {
    const store = new Store(":memory:");
    store.setApproveFirst("team", true);
    assert.deepEqual(store.approveFirstNamespaces(), ["team"]);
    setProcessWriter("stdio");
    assert.ok(store.create({ namespace: "default", title: "free" }));
    assert.throws(() => store.create({ namespace: "team", title: "held" }), QuarantinedError);
    store.setApproveFirst("team", false);
    assert.deepEqual(store.approveFirstNamespaces(), []);
    assert.ok(store.create({ namespace: "team", title: "after off" }));
    assert.equal(store.listQuarantine().length, 1, "what was held before stays queued");
    store.close();
  });

  test("the store-wide switch holds an agent write to a namespace created later", () => {
    const store = new Store(":memory:");
    setProcessWriter("stdio");
    assert.ok(store.create({ namespace: "before", title: "free" }));
    store.setApproveFirstAll(true);
    assert.equal(store.approveFirstAll(), true);
    assert.equal(store.isApproveFirst("brand-new-ns"), true);
    assert.throws(() => store.create({ namespace: "brand-new-ns", title: "held" }), QuarantinedError);
    assert.deepEqual(store.approveFirstNamespaces(), [], "the per-namespace list is untouched");
    setProcessWriter("cli");
    assert.ok(store.create({ namespace: "brand-new-ns", title: "operator ok" }));
    store.setApproveFirstAll(false);
    setProcessWriter("stdio");
    assert.ok(store.create({ namespace: "another-new", title: "free again" }));
    store.close();
  });

  test("REST: PUT {all:true,on} flips the switch; a namespace-pinned token cannot", async () => {
    const store = new Store(":memory:");
    const server = createApiServer(store, "tok-admin-1234567890");
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { Authorization: "Bearer tok-admin-1234567890", "Content-Type": "application/json" };
    try {
      let res = await fetch(`${base}/approve-first`, { method: "PUT", headers: H, body: JSON.stringify({ all: true, on: true }) });
      assert.equal(res.status, 200);
      assert.deepEqual(await (await fetch(`${base}/approve-first`, { headers: H })).json(), { namespaces: [], all: true });
      res = await fetch(`${base}/approve-first`, { method: "PUT", headers: H, body: JSON.stringify({ all: true }) });
      assert.equal(res.status, 400);
      res = await fetch(`${base}/notes`, { method: "POST", headers: H, body: JSON.stringify({ namespace: "fresh", title: "via rest" }) });
      assert.equal(res.status, 202);
      res = await fetch(`${base}/approve-first`, { method: "PUT", headers: H, body: JSON.stringify({ all: true, on: false }) });
      assert.equal(res.status, 200);
      assert.equal(store.approveFirstAll(), false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("a secret is still refused, not held", () => {
    const store = new Store(":memory:");
    store.setApproveFirst("team", true);
    assert.throws(
      () => store.create({ namespace: "team", title: "k", body: "ghp_" + "a".repeat(36) }),
      (e: Error) => !(e instanceof QuarantinedError) && /refusing to store/.test(e.message)
    );
    assert.equal(store.listQuarantine().length, 0);
    store.close();
  });

  test("no MCP tool can toggle it, and stdio cannot approve its own held write", async () => {
    const prior = process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    delete process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    const store = new Store(":memory:");
    store.setApproveFirst("team", true);
    setProcessWriter("stdio");
    try {
      const c = await connect(store, { local: true });
      const names = (await c.listTools()).tools.map((t) => t.name);
      assert.ok(!names.some((n) => /approve.?first/i.test(n)), "no approve-first tool");
      for (const t of (await c.listTools()).tools) {
        assert.doesNotMatch(JSON.stringify(t.inputSchema), /approve.?first/i, `${t.name} must not take an approve-first argument`);
      }
      const held = parse(await c.callTool({ name: "state_write", arguments: { namespace: "team", title: "mine" } }));
      const r: any = await c.callTool({ name: "memory_quarantine", arguments: { action: "approve", id: held.quarantined.id } });
      assert.equal(r.isError, true, "memory_quarantine is not registered over stdio by default");
      assert.match(r.content[0].text, /not found/);
      assert.deepEqual(titles(store, "team"), []);
      await c.close();
    } finally {
      if (prior !== undefined) process.env.MONOMEM_STDIO_ADMIN_TOOLS = prior;
      store.close();
    }
  });

  test("REST: an admin-token write is held; GET/PUT /approve-first need admin", async () => {
    const store = new Store(":memory:");
    const server = createApiServer(store, "tok-admin-1234567890");
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { Authorization: "Bearer tok-admin-1234567890", "Content-Type": "application/json" };
    try {
      let res = await fetch(`${base}/approve-first`, { method: "PUT", headers: H, body: JSON.stringify({ namespace: "team", on: true }) });
      assert.equal(res.status, 200);
      assert.deepEqual(await (await fetch(`${base}/approve-first`, { headers: H })).json(), { namespaces: ["team"], all: false });
      res = await fetch(`${base}/approve-first`, { method: "PUT", headers: H, body: JSON.stringify({ namespace: "team" }) });
      assert.equal(res.status, 400);
      res = await fetch(`${base}/notes`, { method: "POST", headers: H, body: JSON.stringify({ namespace: "team", title: "via rest" }) });
      assert.equal(res.status, 202);
      assert.equal(((await res.json()) as any).quarantined.reasons[0].category, "approval");
      assert.deepEqual(titles(store, "team"), []);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("REST archive, restore and hard delete there are refused with a 400, not a 500", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const n = store.create({ namespace: "team", title: "deploy rule", body: "fridays only" });
    store.setApproveFirst("team", true);
    setProcessWriter("");
    const server = createApiServer(store, "tok-admin-1234567890");
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { Authorization: "Bearer tok-admin-1234567890", "Content-Type": "application/json" };
    try {
      for (const [method, path] of [["POST", `/notes/${n.id}/archive`], ["POST", `/notes/${n.id}/restore`], ["DELETE", `/notes/${n.id}`]]) {
        const res = await fetch(`${base}${path}`, { method, headers: H });
        assert.equal(res.status, 400, `${method} ${path}`);
        assert.match(((await res.json()) as any).error, /approve-first/);
      }
      assert.ok(store.read(n.id), "note still there");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("the operator (CLI) can still replace notes there", () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const old = store.create({ namespace: "team", title: "deploy rule", body: "fridays only" });
    const nw = store.create({ namespace: "team", title: "deploy rule v2", body: "any day" });
    store.setApproveFirst("team", true);
    assert.doesNotThrow(() => supersedePreview(store, { scope: "admin", writer: "cli" }, { old_ids: [old.id], new_id: nw.id }));
    store.close();
  });

  test("the CLI sets, lists and clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-af-"));
    try {
      const db = join(dir, "state.db");
      new Store(db).close();
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
      const cli = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "approve-first", ...args], { env, encoding: "utf8" });
      let r = cli("team", "on");
      assert.equal(r.status, 0, r.stderr);
      r = cli();
      assert.match(r.stdout, /Approve-first for these namespaces: team/);
      assert.equal(cli("team", "maybe").status, 1);
      // Lowering protection needs a terminal and a typed yes: from a script it is refused and nothing changes.
      const off = cli("team", "off");
      assert.equal(off.status, 1);
      assert.match(off.stderr, /person must run it in a terminal/);
      assert.match(cli().stdout, /Approve-first for these namespaces: team/);
      const s2 = new Store(db);
      s2.setApproveFirst("team", false); // the store method itself is unchanged
      s2.close();
      assert.match(cli().stdout, /individual namespaces: none/);
      // The store-wide switch: on is scriptable, off needs the same terminal gate, and the list shows it.
      assert.match(cli().stdout, /All namespaces: off/);
      r = cli("--all", "on");
      assert.equal(r.status, 0, r.stderr);
      assert.match(cli().stdout, /All namespaces: on/);
      const allOff = cli("--all", "off");
      assert.equal(allOff.status, 1);
      assert.match(allOff.stderr, /person must run it in a terminal/);
      assert.match(cli().stdout, /All namespaces: on/);
      assert.equal(cli("--all").status, 1);
      assert.equal(cli("--all", "maybe").status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('state_search mode "relevant"', () => {
  test("matches state_relevant's result", async () => {
    const store = new Store(":memory:");
    store.create({ title: "acme launch decision", body: "we ship in march" });
    store.create({ title: "unrelated", body: "lunch menu" });
    const c = await connect(store);
    const viaSearch = parseRead(await c.callTool({ name: "state_search", arguments: { query: "what did we decide about acme?", mode: "relevant" } }));
    const viaTool = parseRead(await c.callTool({ name: "state_relevant", arguments: { message: "what did we decide about acme?" } }));
    assert.deepEqual(viaSearch.keywords, viaTool.keywords);
    assert.deepEqual(viaSearch.results.map((n: any) => n.id), viaTool.results.map((n: any) => n.id));
    assert.ok(viaSearch.results.some((n: any) => n.title === "acme launch decision"));
    const bad: any = await c.callTool({ name: "state_search", arguments: { query: "acme", mode: "relevant", when: "yesterday" } });
    assert.equal(bad.isError, true);
    await c.close();
    store.close();
  });

  test("state_relevant is out of the default set (seven tools) but still registered", () => {
    assert.equal(DEFAULT_TOOLS.length, 7);
    assert.ok(!DEFAULT_TOOLS.includes("state_relevant"));
  });
});
