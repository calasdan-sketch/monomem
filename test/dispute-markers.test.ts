// R2-01 (1.5.0): dispute markers on every read. Two writers give deploy_target different values: every read of either note
// carries `disputed` (REST and MCP alike), the MCP "who wrote this" block shows one DISPUTED line, and a side a person
// confirmed ranks first while the other side is labelled "disputed by a confirmed note". Nothing is hidden.
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
import { disputeFields } from "../src/facts.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);

function seed() {
  const s = new Store(":memory:");
  const fly = as("stdio:cursor", () => s.create({ title: "deploy on fly", body: "zebra", tags: ["fact:deploy_target=fly"] }));
  const render = as("stdio:claude", () => s.create({ title: "deploy on render", body: "zebra", tags: ["fact:deploy_target=render"] }));
  const plain = as("stdio:claude", () => s.create({ title: "unrelated zebra", body: "zebra" }));
  return { s, fly, render, plain };
}

describe("R2-01 dispute markers", () => {
  test("store level: each side names the other; a note without a dispute keeps its shape", () => {
    const { s, fly, render, plain } = seed();
    const f = disputeFields(s, s.read(fly.id)!);
    assert.deepEqual(f.disputed, [{ id: render.id, key: "deploy_target", value: "render", written_by: "token:stdio:claude", confirmed: false }]);
    assert.equal(f.disputed_label, undefined);
    assert.equal(disputeFields(s, s.read(render.id)!).disputed![0].id, fly.id);
    assert.deepEqual(disputeFields(s, s.read(plain.id)!), {});
    s.close();
  });

  test("a person-confirmed side ranks first; the other side is labelled", () => {
    const { s, fly, render } = seed();
    const third = as("stdio:codex", () => s.create({ title: "deploy on heroku", body: "z", tags: ["fact:deploy_target=heroku"] }));
    s.captureDb().prepare("UPDATE notes SET confirmed_kind = 'human', confirmed_rev = rev, confirmed_at = ?, confirmed_by = 'cli' WHERE id = ?").run(new Date().toISOString(), third.id);
    const f = disputeFields(s, s.read(fly.id)!);
    assert.deepEqual(f.disputed!.map((d) => d.id), [third.id, render.id]);
    assert.equal(f.disputed![0].confirmed, true);
    assert.equal(f.disputed_label, "disputed by a confirmed note");
    // The confirmed note itself is not labelled.
    assert.equal(disputeFields(s, s.read(third.id)!).disputed_label, undefined);
    s.close();
  });

  test("the same writer changing its mind is not a dispute; a distrusted writer's note is not a side", () => {
    const s = new Store(":memory:");
    const a = as("stdio:cursor", () => s.create({ title: "a", tags: ["fact:deploy_target=fly"] }));
    as("stdio:cursor", () => s.create({ title: "b", tags: ["fact:deploy_target=render"] }));
    assert.deepEqual(disputeFields(s, s.read(a.id)!), {});
    as("evil", () => s.create({ title: "c", tags: ["fact:deploy_target=heroku"] }));
    s.distrustAdd("default", "evil");
    assert.deepEqual(disputeFields(s, s.read(a.id)!), {});
    s.close();
  });

  test("REST and MCP: every read route carries the marker", async () => {
    const { s, fly, render } = seed();
    const tok = "r".padEnd(32, "x");
    const http = createApiServer(s, [{ token: tok, scope: "read", label: "reader" }], {});
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const rest = async (m: string, p: string, b?: unknown): Promise<string> =>
      (await fetch(base + p, { method: m, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) })).text();
    const server = createMcpServer(s, "read", { tools: "all" }, { label: "reader", authed: true });
    const [c1, c2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c1), server.connect(c2)]);
    const mcp = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content.map((c) => c.text);
    try {
      const marker = new RegExp(`"disputed":\\[\\{"id":${render.id},"key":"deploy_target","value":"render"`);
      for (const [label, text] of [
        ["GET /notes/:id", await rest("GET", `/notes/${fly.id}`)],
        ["GET /notes", await rest("GET", `/notes`)],
        ["GET /search", await rest("GET", `/search?q=zebra`)],
        ["GET /index", await rest("GET", `/index`)],
        ["POST /get", await rest("POST", `/get`, { ids: [fly.id] })],
      ] as const) assert.match(text, marker, label);
      for (const [name, args] of [
        ["state_read", { id: fly.id }],
        ["state_list", {}],
        ["state_search", { query: "zebra" }],
        ["memory_index", {}],
        ["memory_get", { ids: [fly.id] }],
      ] as const) {
        const [json, who] = await mcp(name, args);
        assert.match(json, marker, name);
        if (name !== "memory_index") assert.match(who, new RegExp(`DISPUTED deploy_target: #${render.id} says "render" \\("token:stdio:claude", unconfirmed\\)`), `${name} banner`);
      }
    } finally {
      await client.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      s.close();
    }
  });
});
