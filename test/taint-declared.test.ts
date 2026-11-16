// 1.4.0 taint, signal 3 (declared): `outside: true` on a write, and a token marked `reads_outside`, add obs.origin:declared.
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
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { resolveTokens } from "../src/config.js";
import { setProcessWriter } from "../src/actor.js";

const json = (r: any) => {
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};
async function connect(store: Store, conn = {}) {
  const server = createMcpServer(store, "write", {}, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

afterEach(() => {
  setProcessWriter("");
  delete process.env.MONOMEM_TOKENS;
});

describe("declared outside content", () => {
  test("MCP state_write outside:true marks the note; outside:false on update never removes it", async () => {
    const store = new Store(":memory:");
    setProcessWriter("stdio");
    const c = await connect(store, { local: true });
    const w = json(await c.callTool({ name: "state_write", arguments: { title: "from the docs site", body: "x", outside: true } }));
    assert.ok(w.note.tags.includes("obs.origin:declared"));
    const u = json(await c.callTool({ name: "state_write", arguments: { id: w.note.id, body: "edited", outside: false } }));
    assert.ok(u.note.tags.includes("obs.origin:declared"));
    assert.equal(store.read(w.note.id)!.unconfirmed, true);
    await c.close();
    store.close();
  });

  test("a token marked reads_outside: every write over MCP-HTTP and REST is declared", async () => {
    process.env.MONOMEM_TOKENS = JSON.stringify([{ token: "browser-token-cccccccccccccccccccccc", scope: "write", label: "browser-bot", reads_outside: true }]);
    const entry = resolveTokens().find((t) => t.label === "browser-bot")!;
    assert.equal(entry.reads_outside, true);
    const store = new Store(":memory:");
    const c = await connect(store, { label: "browser-bot", authed: true, readsOutside: true });
    const w = json(await c.callTool({ name: "state_write", arguments: { title: "t1", body: "b" } }));
    assert.ok(w.note.tags.includes("obs.origin:declared"));
    await c.close();
    const http = createApiServer(store, [entry]);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    try {
      const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const post = (body: unknown) =>
        fetch(base + "/notes", { method: "POST", headers: { authorization: `Bearer ${entry.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const r = (await (await post({ title: "t2", body: "b" })).json()) as any;
      assert.ok(r.note.tags.includes("obs.origin:declared"));
      assert.equal((await post({ title: "t3", outside: "yes" })).status, 400, "outside must be a boolean");
    } finally {
      await new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      });
      store.close();
    }
  });

  test("CLI: add --outside marks the note and says how to confirm; confirm from a script is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-taint-cli-"));
    try {
      const db = join(dir, "state.db");
      new Store(db).close();
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
      const cli = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), ...args], { env, encoding: "utf8" });
      const r = cli("add", "the vendor page says 40", "--outside");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /monomem confirm 1/);
      const c = cli("confirm", "1", "--source", "vendor site");
      assert.equal(c.status, 1);
      assert.match(c.stderr, /Refused: .* a person must run it in a terminal/);
      const s = new Store(db);
      assert.equal(s.read(1)!.unconfirmed, true, "nothing changed");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
