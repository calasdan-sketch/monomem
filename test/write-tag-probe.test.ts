// 1.5.0 (round 2, A2): MCP state_write must not tell a hidden note apart from a missing one through the reserved-tag guard.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { actorStore } from "../src/actor.js";

describe("A2 state_write tag guard runs after the visibility check", () => {
  test("a distrusted note with a reserved tag, one without, and a missing id all read 'no note'", async () => {
    const s = new Store(":memory:");
    const hidden = actorStore.run({ label: "evil", authed: true }, () => s.create({ title: "h", body: "x", tags: ["handoff"] }));
    const plain = actorStore.run({ label: "evil", authed: true }, () => s.create({ title: "p", body: "x" }));
    s.distrustAdd("default", "evil");
    const server = createMcpServer(s, "write", {}, { label: "agent", authed: true });
    const [c1, s1] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c1), server.connect(s1)]);
    try {
      const call = async (id: number) => ((await client.callTool({ name: "state_write", arguments: { id, tags: [] } })) as any).content[0].text as string;
      for (const id of [hidden.id, plain.id, 999]) assert.match(await call(id), new RegExp(`no note with id ${id}`), `id ${id}`);
      assert.deepEqual(s.read(hidden.id)!.tags, ["handoff"], "the hidden note is untouched");
    } finally {
      await client.close();
      s.close();
    }
  });
});
