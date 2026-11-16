// A3: state_write never saves (or edits into) a note whose text went to an argument the tool does not have.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";

const text = (r: any): string => r.content?.[0]?.text ?? "";

async function mcp(store: Store) {
  const server = createMcpServer(store, "admin", {}, { local: true });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

for (const key of ["content", "text", "note"]) {
  test(`state_write: title + ${key} (no body) is refused: no note, no receipt`, async () => {
    const s = new Store(":memory:");
    const c = await mcp(s);
    try {
      const r: any = await c.callTool({ name: "state_write", arguments: { title: "deploy", [key]: "we deploy on fridays" } });
      assert.equal(r.isError, true, text(r));
      assert.match(text(r), new RegExp(`you sent \`${key}\`; use \`body\``));
      assert.equal(s.list({}).total, 0);
      assert.doesNotMatch(text(r), /receipt/);
    } finally {
      await c.close();
      s.close();
    }
  });
}

test("state_write update (id set) with content but no body is refused and the note is unchanged", async () => {
  const s = new Store(":memory:");
  const c = await mcp(s);
  try {
    const n = s.create({ title: "deploy", body: "old text" });
    const r: any = await c.callTool({ name: "state_write", arguments: { id: n.id, content: "new text" } });
    assert.equal(r.isError, true, text(r));
    assert.match(text(r), /use `body`/);
    assert.equal(s.read(n.id)!.body, "old text");
    assert.equal(s.read(n.id)!.rev, n.rev);
  } finally {
    await c.close();
    s.close();
  }
});

test("state_write with body AND an ignored content key still saves (content reported as ignored)", async () => {
  const s = new Store(":memory:");
  const c = await mcp(s);
  try {
    const r: any = await c.callTool({ name: "state_write", arguments: { title: "t", body: "b", content: "x" } });
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /ignored_arguments/);
  } finally {
    await c.close();
    s.close();
  }
});
