// 1.4.0: taint only grows. An agent can neither add an obs.origin:* tag by hand nor strip one, on any write path.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { assertPlainWriteTags } from "../src/reserved-tags.js";
import { setProcessWriter } from "../src/actor.js";

async function connect(store: Store) {
  const server = createMcpServer(store, "admin", {}, { local: true });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

afterEach(() => setProcessWriter(""));

describe("taint is immutable to agents", () => {
  test("a plain write cannot mint or drop any obs.origin tag", () => {
    for (const t of ["obs.origin:via:memory", "obs.origin:declared", "obs.origin:tool:WebFetch"]) {
      assert.throws(() => assertPlainWriteTags([t]), /reserved/, t);
      assert.throws(() => assertPlainWriteTags([], [t]), /reserved/, `dropping ${t}`);
    }
  });

  test("MCP: state_write with an obs.origin tag is refused; re-sending the tags without it is refused too", async () => {
    const store = new Store(":memory:");
    setProcessWriter("stdio");
    const c = await connect(store);
    const r: any = await c.callTool({ name: "state_write", arguments: { title: "x", tags: ["obs.origin:declared"] } });
    assert.ok(r.isError);
    const n = store.create({ title: "y", outside: true });
    const u: any = await c.callTool({ name: "state_write", arguments: { id: n.id, tags: ["clean"] } });
    assert.ok(u.isError, "dropping the mark through the MCP tool is refused");
    assert.ok(store.read(n.id)!.tags.includes("obs.origin:declared"));
    await c.close();
    store.close();
  });

  test("store level (file sync, import, restore all route here): an update that leaves the marks out keeps them", () => {
    const store = new Store(":memory:");
    setProcessWriter("stdio");
    const n = store.create({ title: "z", body: "clean text" });
    const u = store.update(n.id, { tags: [], body: "from the page", outside: true });
    assert.ok(u!.tags.includes("obs.origin:declared"));
    // Restoring the clean earlier version does not take the mark away: the note once held outside content.
    const v = store.historyOf(n.id)[0].version;
    const back = store.restoreVersion(n.id, v)!;
    assert.equal(back.body, "clean text");
    assert.ok(back.tags.includes("obs.origin:declared"));
    store.close();
  });
});
