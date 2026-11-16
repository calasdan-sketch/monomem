// r2-improvement #3: overwriting another writer's note is never silent, and a stale write says who changed it, how, and what.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";

const text = (r: any): string => r.content?.[0]?.text ?? "";
const json = (r: any): any => {
  const t = text(r);
  return JSON.parse(t.slice(t.indexOf("{")));
};
async function as(store: Store, label: string) {
  const server = createMcpServer(store, "write", {}, { label, authed: true });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: label, version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

test("B overwrites A's note without if_rev: B's reply names A with a diff; A's catch_up shows the overwrite", async () => {
  const s = new Store(":memory:");
  const a = await as(s, "claude");
  const b = await as(s, "codex");
  try {
    const n = json(await a.callTool({ name: "state_write", arguments: { title: "deploy", body: "we deploy to fly.io" } })).note;
    const r = json(await b.callTool({ name: "state_write", arguments: { id: n.id, body: "we deploy to render.com" } }));
    assert.equal(r.replaced_other_writer.by, "claude");
    assert.equal(r.replaced_other_writer.old_rev, n.rev);
    assert.ok(r.replaced_other_writer.line_diff.some((l: string) => l.startsWith("- ") && l.includes("fly.io")));
    assert.match(r.notice, /claude/);
    // B editing its own note again: no notice
    const r2 = json(await b.callTool({ name: "state_write", arguments: { id: n.id, body: "we deploy to render.com (eu)" } }));
    assert.equal(r2.replaced_other_writer, undefined);
    // A hears about it
    const cu = json(await a.callTool({ name: "catch_up", arguments: {} }));
    assert.ok(Array.isArray(cu.overwritten) && cu.overwritten.some((o: any) => o.id === n.id && o.by === "codex"), JSON.stringify(cu.overwritten));
  } finally {
    await a.close();
    await b.close();
    s.close();
  }
});

test("a stale write names who changed the note, how, the current rev and a short diff", async () => {
  const s = new Store(":memory:");
  const a = await as(s, "claude");
  const b = await as(s, "codex");
  try {
    const n = json(await a.callTool({ name: "state_write", arguments: { title: "deploy", body: "line one\nfly.io" } })).note;
    await b.callTool({ name: "state_write", arguments: { id: n.id, body: "line one\nrender.com", if_rev: n.rev } });
    const r: any = await a.callTool({ name: "state_write", arguments: { id: n.id, body: "line one\nheroku", if_rev: n.rev } });
    assert.equal(r.isError, true);
    const e = json(r);
    assert.match(e.error, /stale write/);
    assert.match(e.error, /codex/);
    assert.equal(e.stale.current_rev, n.rev + 1);
    assert.equal(e.stale.changed_by, "codex");
    assert.ok(e.stale.how);
    assert.ok(e.stale.line_diff.some((l: string) => l.startsWith("+ ") && l.includes("render.com")));
    assert.match(text(r), /UNTRUSTED/, "note text in the error carries the untrusted banner");
  } finally {
    await a.close();
    await b.close();
    s.close();
  }
});
