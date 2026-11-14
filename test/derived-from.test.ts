// 1.4.0 (1d) derived_from: add-only links, taint inherited at write, one-hop distrust flag (out of session start, still readable).
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { injectContext, rankContext } from "../src/context-inject.js";
import { runSearch } from "../src/search-service.js";
import { setProcessWriter, actorStore } from "../src/actor.js";

const noGit = { branch: "", diffFiles: [] };
const as = <T>(label: string, f: () => T): T => actorStore.run({ label, authed: true }, f);
const json = (r: any) => {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};
afterEach(() => setProcessWriter(""));

describe("derived_from", () => {
  test("stored, shown on reads, validated (unknown id, too many, itself)", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const a = s.create({ title: "source a", body: "x" });
    const c = s.create({ title: "summary", body: "y", derived_from: [a.id] });
    assert.deepEqual(s.read(c.id)!.derived_from, [a.id]);
    assert.equal(s.read(a.id)!.derived_from, undefined, "no links, no field");
    assert.throws(() => s.create({ title: "bad", derived_from: [9999] }), /derived_from: no note with id 9999/);
    assert.throws(() => s.create({ title: "bad", derived_from: Array.from({ length: 21 }, () => a.id) }), /at most 20/);
    assert.throws(() => s.create({ title: "bad", derived_from: ["x" as never] }), /derived_from/);
    assert.throws(() => s.update(c.id, { derived_from: [c.id] }), /itself/);
    s.close();
  });

  test("add-only: an update can add links, never remove them", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const a = s.create({ title: "a", body: "x" });
    const b = s.create({ title: "b", body: "x" });
    const c = s.create({ title: "c", body: "y", derived_from: [a.id] });
    s.update(c.id, { derived_from: [b.id] });
    assert.deepEqual(s.read(c.id)!.derived_from, [a.id, b.id]);
    s.update(c.id, { body: "edited", derived_from: [] });
    s.update(c.id, { title: "c2" });
    assert.deepEqual(s.read(c.id)!.derived_from, [a.id, b.id]);
    s.close();
  });

  test("built from an unconfirmed note: inherits via:memory and is unconfirmed; from a confirmed one: clean", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const out = s.create({ title: "vendor page", body: "x", outside: true });
    const child = s.create({ title: "paraphrase", body: "y", derived_from: [out.id] });
    assert.ok(child.tags.includes("obs.origin:via:memory"));
    assert.equal(child.unconfirmed, true);
    const plain = s.create({ title: "plain", body: "z" });
    const edited = s.update(plain.id, { derived_from: [out.id] })!;
    assert.ok(edited.tags.includes("obs.origin:via:memory"), "adding the link on an edit taints too");
    setProcessWriter("cli");
    s.confirm(out.id, { source: "checked" });
    setProcessWriter("stdio");
    const clean = s.create({ title: "after confirm", body: "w", derived_from: [out.id] });
    assert.ok(!clean.tags.some((t) => t.startsWith("obs.origin:")));
    s.close();
  });

  test("one hop of distrust: flagged, out of session start, still in list and search", async () => {
    const s = new Store(":memory:");
    const parent = as("bad-bot", () => s.create({ title: "parent claim", body: "wombat" }));
    const child = as("good-bot", () => s.create({ title: "ZZ-CHILD built on it", body: "wombat summary", derived_from: [parent.id] }));
    assert.equal(s.read(child.id)!.built_on_distrusted, undefined);
    s.distrustAdd("default", "bad-bot");
    const r = s.read(child.id)!;
    assert.equal(r.built_on_distrusted, true);
    assert.equal(r.built_on_distrusted_label, "[built on a distrusted writer]");
    assert.ok(s.list({}).notes.some((n) => n.id === child.id), "still listed");
    assert.ok((await runSearch(s, "wombat")).some((n) => n.id === child.id && n.built_on_distrusted), "still searchable, flagged");
    const pool = await rankContext(s, { signals: noGit });
    assert.ok(!pool.ranked.some((n) => n.id === child.id));
    assert.ok(!(await injectContext(s, { signals: noGit })).includes("ZZ-CHILD"));
    s.close();
  });

  test("MCP state_write and REST POST/PUT take derived_from", async () => {
    const store = new Store(":memory:");
    setProcessWriter("stdio");
    const a = store.create({ title: "a", body: "x" });
    const server = createMcpServer(store, "write", {}, { local: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([c.connect(ct), server.connect(st)]);
    const w = json(await c.callTool({ name: "state_write", arguments: { title: "m", body: "y", derived_from: [String(a.id)] } }));
    assert.deepEqual(w.note.derived_from, [a.id]);
    const bad = await c.callTool({ name: "state_write", arguments: { title: "m2", derived_from: ["424242"] } });
    assert.match((bad.content as any)[0].text, /no note with id 424242/);
    await c.close();
    const http = createApiServer(store, [{ token: "t-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", scope: "write", label: "rest-bot" }]);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const call = (method: string, path: string, body: unknown) =>
        fetch(base + path, { method, headers: { authorization: "Bearer t-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "content-type": "application/json" }, body: JSON.stringify(body) });
      const p = (await (await call("POST", "/notes", { title: "r", derived_from: [a.id] })).json()) as any;
      assert.deepEqual(p.note.derived_from, [a.id]);
      const b = store.create({ title: "b", body: "x" });
      const u = (await (await call("PUT", `/notes/${p.note.id}`, { derived_from: [b.id] })).json()) as any;
      assert.deepEqual((u.note ?? u).derived_from, [a.id, b.id]);
      assert.equal((await call("POST", "/notes", { title: "r2", derived_from: "1" })).status, 400);
    } finally {
      await new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      });
      store.close();
    }
  });
});
