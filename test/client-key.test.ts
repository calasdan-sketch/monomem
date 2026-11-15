// R2-04 (1.5.0): `client_key` on state_write / POST /notes. A retry with the same key from the same writer returns the
// original note (deduplicated: true) and writes nothing; another writer's same key is its own key.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const count = (s: Store) => s.list({ limit: 100 }).notes.length;

describe("R2-04 client_key on note writes", () => {
  test("store: same key twice -> one note; another writer's same key -> a second note", () => {
    const s = new Store(":memory:");
    const a = as("stdio:a", () => s.createOnce({ title: "deploy", body: "x" }, "k-1"));
    const again = as("stdio:a", () => s.createOnce({ title: "deploy (retry)", body: "y" }, "k-1"));
    assert.equal(a.deduplicated, undefined);
    assert.equal(again.deduplicated, true);
    assert.equal(again.note.id, a.note.id);
    assert.equal(again.note.title, "deploy", "the original note, not the retry's text");
    const b = as("stdio:b", () => s.createOnce({ title: "deploy", body: "x" }, "k-1"));
    assert.notEqual(b.note.id, a.note.id);
    assert.equal(count(s), 2);
    s.close();
  });

  test("a retry is not a write: no flood count", () => {
    const s = new Store(":memory:");
    as("stdio:a", () => s.createOnce({ title: "t", body: "b" }, "k"));
    const db = s.captureDb();
    const before = db.prepare("SELECT count(*) AS c FROM write_rate").get() as { c: number };
    as("stdio:a", () => s.createOnce({ title: "t", body: "b" }, "k"));
    const after = db.prepare("SELECT count(*) AS c FROM write_rate").get() as { c: number };
    assert.equal(after.c, before.c);
    s.close();
  });

  test("a bad key is refused; the raw key is never stored", () => {
    const s = new Store(":memory:");
    assert.throws(() => s.createOnce({ title: "t" }, "has space"), /client_key/);
    assert.throws(() => s.createOnce({ title: "t" }, "x".repeat(129)), /client_key/);
    as("stdio:a", () => s.createOnce({ title: "t" }, "secret-key-123"));
    const rows = s.captureDb().prepare("SELECT key_hash FROM note_client_keys").all() as Array<{ key_hash: string }>;
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].key_hash.includes("secret-key-123"));
    s.close();
  });

  test("deleting the note frees the key", () => {
    const s = new Store(":memory:");
    const a = as("stdio:a", () => s.createOnce({ title: "t" }, "k"));
    s.delete(a.note.id);
    const b = as("stdio:a", () => s.createOnce({ title: "t" }, "k"));
    assert.equal(b.deduplicated, undefined);
    s.close();
  });

  test("REST POST /notes and MCP state_write agree", async () => {
    const s = new Store(":memory:");
    const tok = "w".padEnd(32, "x");
    const server = createApiServer(s, [{ token: tok, scope: "write", label: "agent" }], {});
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (body: object) => {
      const r = await fetch(base + "/notes", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as { note: { id: number }; deduplicated?: boolean } };
    };
    const mcp = createMcpServer(s, "write", {}, { label: "agent", authed: true });
    const [ta, tb] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "ck", version: "1" });
    await Promise.all([c.connect(ta), mcp.connect(tb)]);
    try {
      const r1 = await post({ title: "one", body: "b", client_key: "rest-1" });
      const r2 = await post({ title: "one", body: "b", client_key: "rest-1" });
      assert.equal(r1.status, 201);
      assert.equal(r2.status, 200);
      assert.equal(r2.json.deduplicated, true);
      assert.equal(r2.json.note.id, r1.json.note.id);
      // Same writer label over MCP, same key: the same note.
      const m = (await c.callTool({ name: "state_write", arguments: { title: "one", body: "b", client_key: "rest-1" } })) as { content: Array<{ text: string }>; isError?: boolean };
      assert.ok(!m.isError);
      const text = m.content.map((x) => x.text).join("\n");
      assert.match(text, /"deduplicated":\s*true/);
      assert.match(text, new RegExp(`"id":\\s*${r1.json.note.id}\\b`));
      // A key with an id is refused on both surfaces.
      const mu = (await c.callTool({ name: "state_write", arguments: { id: r1.json.note.id, body: "z", client_key: "k" } })) as { isError?: boolean };
      assert.equal(mu.isError, true);
      const bad = await post({ title: "x", client_key: "bad key" });
      assert.equal(bad.status, 400);
      assert.equal(count(s), 1);
    } finally {
      await c.close();
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });
});
