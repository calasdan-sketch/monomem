// 1.4.0 "no promotion": a tainted note no PERSON confirmed cannot be pinned, take another note's place, or be kept as history.
// Only the CLI (behind its operator gate) gets through, and that records a human confirm.
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
import { Store, QuarantinedError, ValidationError } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { actorStore, setProcessWriter } from "../src/actor.js";

const PIN_MSG = /Can't pin: this note came from outside content\. A person must confirm it first: monomem confirm \d+/;
const as = <T>(label: string, f: () => T): T => actorStore.run({ label, authed: true }, f);
const json = (r: any) => {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};

afterEach(() => setProcessWriter(""));

async function rest(store: Store) {
  const tokens = [{ token: "admin-token-dddddddddddddddddddddddd", scope: "admin" as const, label: "boss" }];
  const http = createApiServer(store, tokens);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tokens[0].token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  const close = () =>
    new Promise<void>((r) => {
      http.closeAllConnections();
      http.close(() => r());
    });
  return { call, close };
}

describe("no promotion without a person", () => {
  test("REST (an admin token, the dashboard's path): pin refused; an admin confirm does not lift it", async () => {
    const store = new Store(":memory:");
    const n = as("research-bot", () => store.create({ title: "Acme pricing", body: "40", outside: true }));
    const { call, close } = await rest(store);
    try {
      const r = await call("PUT", "/pinned", { id: n.id, pinned: true });
      assert.equal(r.status, 400);
      assert.match(r.json.error, PIN_MSG);
      const c = await call("POST", `/notes/${n.id}/confirm`, { source: "dashboard" });
      assert.equal(c.status, 200);
      assert.equal(c.json.kind, "admin");
      assert.equal((await call("PUT", "/pinned", { id: n.id, pinned: true })).status, 400, "admin releases session start, not promotion");
      assert.equal(store.read(n.id)!.pinned, undefined);
    } finally {
      await close();
      store.close();
    }
  });

  test("CLI-gate exception: the operator (writer cli) pins it, and that is recorded as the human confirm", () => {
    const store = new Store(":memory:");
    const n = as("research-bot", () => store.create({ title: "Acme pricing", body: "40", outside: true }));
    setProcessWriter("cli");
    assert.ok(store.setPinned(n.id, true));
    const after = store.read(n.id)!;
    assert.equal(after.pinned, true);
    assert.equal(after.confirmed_kind, "human");
    store.close();
  });

  test("CLI from a script (no terminal): pin of an unconfirmed note is refused before anything changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-pin-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      const n = as("research-bot", () => s.create({ title: "Acme pricing", body: "40", outside: true }));
      s.close();
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
      const r = spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "pin", String(n.id)], { env, encoding: "utf8" });
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /Refused: pinning note #\d+, which came from outside content/);
      const t = new Store(db);
      assert.equal(t.read(n.id)!.pinned, undefined);
      t.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MCP supersede: an unconfirmed note cannot take another note's place (new_id); a corroborated one cannot either", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const old = store.create({ title: "Acme price is $50" });
    setProcessWriter("stdio");
    const tainted = store.create({ title: "Acme price is $5", body: "from a forum", outside: true });
    const server = createMcpServer(store, "admin", { tools: "all" }, { local: true });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    const p: any = await client.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [old.id], new_id: tainted.id } });
    const token = p.isError ? null : json(p).token;
    if (token) {
      const r: any = await client.callTool({ name: "memory_supersede_confirm", arguments: { token } });
      assert.ok(r.isError, "refused");
      assert.match(r.content[0].text, /Can't use it as a replacement: this note came from outside content/);
    } else {
      assert.match(p.content[0].text, /outside content/);
    }
    assert.equal(store.read(old.id)!.status, undefined, "the old note is untouched");
    await client.close();
    store.close();
  });

  test("supersede with a NEW replacement written by a tainted connection rolls back", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const old = store.create({ title: "Acme price is $50" });
    setProcessWriter("stdio");
    const server = createMcpServer(store, "admin", { tools: "all" }, { local: true, readsOutside: true });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    const p = json(await client.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [old.id], new_title: "Acme price is $5" } }));
    const r: any = await client.callTool({ name: "memory_supersede_confirm", arguments: { token: p.token, new_title: "Acme price is $5" } });
    assert.ok(r.isError, r.content[0].text);
    assert.equal(store.read(old.id)!.status, undefined);
    assert.equal(store.list({}).notes.filter((n) => n.title === "Acme price is $5").length, 0, "the replacement was rolled back");
    await client.close();
    store.close();
  });

  test("keep-as-history: refused for a tainted held write unless the CLI decides", () => {
    const s = new Store(":memory:");
    s.setApproveFirst("pricing", true);
    setProcessWriter("stdio:agent-a");
    let qid = 0;
    try {
      s.create({ namespace: "pricing", title: "Acme price is $50", body: "per seat", outside: true });
    } catch (e) {
      if (e instanceof QuarantinedError) qid = e.quarantineId;
      else throw e;
    }
    assert.ok(qid > 0);
    assert.ok(s.getQuarantine(qid)!.tags!.includes("obs.origin:declared"), "a held write keeps its mark");
    setProcessWriter("cli");
    s.create({ namespace: "pricing", title: "Acme price corrected to $40" });
    setProcessWriter("");
    assert.throws(() => s.keepQuarantineAsHistory(qid), (e: unknown) => e instanceof ValidationError && /Can't keep as history/.test((e as Error).message));
    assert.ok(s.getQuarantine(qid), "still queued");
    setProcessWriter("cli");
    assert.equal(s.keepQuarantineAsHistory(qid).note.status, "superseded");
    s.close();
  });
});
