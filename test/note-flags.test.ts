// R2-02 (1.5.0): memory_flag / POST /notes/:id/flag. An agent says "this looks wrong" without changing the note. A flag by a
// trusted writer takes a note no person confirmed out of session start; a person-confirmed note stays, labelled. Own-note
// flags and distrusted writers' flags do nothing; 20 flags per writer per day. The reason is shown on reads, never at
// session start. `monomem review` lists flagged notes; keep clears the flags for that version.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer, DEFAULT_TOOLS } from "../src/mcp-server-core.js";
import { injectContext } from "../src/context-inject.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const REASON = "package.json says pnpm CANARY-REASON";

function seed() {
  const s = new Store(":memory:");
  const n = as("stdio:claude", () => s.create({ title: "we use npm", body: "npm install everything" }));
  return { s, n };
}

describe("R2-02 note flags", () => {
  test("a flag changes nothing in the note, labels reads, and takes an unconfirmed note out of session start", async () => {
    const { s, n } = seed();
    assert.match(await injectContext(s, {}), /we use npm/);
    const r = as("stdio:codex", () => s.flagNote(n.id, REASON));
    assert.equal(r!.note_id, n.id);
    const after = s.read(n.id)!;
    assert.equal(after.rev, n.rev, "the note is unchanged");
    assert.equal(after.body, n.body);
    assert.equal(after.flagged_label, "[flagged by token:stdio:codex]");
    assert.equal(after.flagged![0].reason, REASON);
    const ctx = await injectContext(s, {});
    assert.ok(!/we use npm/.test(ctx), "left session start");
    assert.ok(!ctx.includes("CANARY-REASON"), "reason never at session start");
    s.close();
  });

  test("a person-confirmed note stays at session start, with the label and without the reason", async () => {
    const { s, n } = seed();
    s.captureDb().prepare("UPDATE notes SET confirmed_kind = 'human', confirmed_rev = rev, confirmed_at = ?, confirmed_by = 'cli' WHERE id = ?").run(new Date().toISOString(), n.id);
    as("stdio:codex", () => s.flagNote(n.id, REASON));
    const ctx = await injectContext(s, {});
    assert.match(ctx, /we use npm/);
    assert.match(ctx, /\[flagged by token:stdio:codex\]/);
    assert.ok(!ctx.includes("CANARY-REASON"));
    s.close();
  });

  test("own-note flags are refused; a distrusted writer's flag does nothing", async () => {
    const { s, n } = seed();
    assert.throws(() => as("stdio:claude", () => s.flagNote(n.id, "mine")), /your own note/);
    as("evil", () => s.flagNote(n.id, "lies"));
    s.distrustAdd("default", "evil");
    assert.equal(s.read(n.id)!.flagged, undefined);
    assert.match(await injectContext(s, {}), /we use npm/);
    s.close();
  });

  test("the 21st flag in a day is refused; flags count in the flood guard", () => {
    const s = new Store(":memory:");
    const ids = Array.from({ length: 21 }, (_, i) => as("stdio:claude", () => s.create({ title: `n${i}`, body: "b" })).id);
    const db = s.captureDb();
    const prev = process.env.MONOMEM_FLOOD_WRITES_PER_HOUR;
    process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "1000"; // setup-env turns the guard off
    try {
      for (const id of ids.slice(0, 20)) as("stdio:codex", () => s.flagNote(id, "x"));
      assert.throws(() => as("stdio:codex", () => s.flagNote(ids[20], "x")), /20 flags/);
      assert.equal((db.prepare("SELECT count(*) AS c FROM write_rate WHERE writer = 'token:stdio:codex'").get() as { c: number }).c, 20);
    } finally {
      process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = prev;
    }
    s.close();
  });

  test("keep clears the flags for the current version; the review list shows flagged notes", () => {
    const { s, n } = seed();
    as("stdio:codex", () => s.flagNote(n.id, REASON));
    assert.deepEqual(s.flaggedList().map((f) => f.id), [n.id]);
    assert.equal(s.keepFlagged(n.id), 1);
    assert.equal(s.read(n.id)!.flagged, undefined);
    assert.deepEqual(s.flaggedList(), []);
    s.close();
  });

  test("REST and MCP: memory_flag is opt-in, both surfaces flag the same way, a hidden note reads as missing", async () => {
    assert.ok(!DEFAULT_TOOLS.includes("memory_flag"));
    const { s, n } = seed();
    const hidden = as("evil", () => s.create({ title: "hidden", body: "b" }));
    s.distrustAdd("default", "evil");
    const tok = "w".padEnd(32, "x");
    const http = createApiServer(s, [{ token: tok, scope: "write", label: "stdio:codex" }], {});
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const post = async (p: string, b: unknown) => {
      const r = await fetch(base + p, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(b) });
      return { status: r.status, text: await r.text() };
    };
    const server = createMcpServer(s, "write", { tools: "all" }, { label: "stdio:cursor", authed: true });
    const [c1, c2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c1), server.connect(c2)]);
    try {
      const r = await post(`/notes/${n.id}/flag`, { reason: REASON });
      assert.equal(r.status, 200, r.text);
      const m = (await client.callTool({ name: "memory_flag", arguments: { id: n.id, reason: "wrong" } })) as { isError?: boolean; content: Array<{ text: string }> };
      assert.ok(!m.isError, m.content[0].text);
      assert.equal(s.read(n.id)!.flagged!.length, 2);
      const rh = await post(`/notes/${hidden.id}/flag`, { reason: "x" });
      const rm = await post(`/notes/99999/flag`, { reason: "x" });
      assert.equal(rh.status, rm.status);
      assert.equal(rh.text.replace(/\d+/g, "N"), rm.text.replace(/\d+/g, "N"));
      const mh = (await client.callTool({ name: "memory_flag", arguments: { id: hidden.id, reason: "x" } })) as { content: Array<{ text: string }> };
      const mm = (await client.callTool({ name: "memory_flag", arguments: { id: 99999, reason: "x" } })) as { content: Array<{ text: string }> };
      assert.equal(mh.content[0].text.replace(/\d+/g, "N"), mm.content[0].text.replace(/\d+/g, "N"));
      assert.equal((await post(`/notes/${n.id}/flag`, { reason: "" })).status, 400);
      // A read over MCP shows the flag and the reason in the who-wrote-this block.
      const read = (await client.callTool({ name: "state_read", arguments: { id: n.id } })) as { content: Array<{ text: string }> };
      assert.match(read.content[1].text, /FLAGGED by "token:stdio:codex": "package\.json says pnpm CANARY-REASON"/);
    } finally {
      await client.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      s.close();
    }
  });
});
