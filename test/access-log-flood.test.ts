// Read access log (who read what, never note text) and the flood guard (a writer making too many writes in an hour is
// paused until an operator resumes it). Both are operator-only: CLI and admin REST, no MCP tool.
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
import { Store, WriterPausedError, SCHEMA_VERSION } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { setProcessWriter } from "../src/actor.js";
import { ensureKey } from "../src/crypto.js";
import { downgradeTo } from "./legacy-db.js";

const SECRET = "api_key=sk9f8e7d6c5b4a3z2y1x";
const BODY = "BODYTEXT-never-in-the-log";

async function connect(store: Store, conn: { label?: string; authed?: boolean; local?: boolean } = {}) {
  const server = createMcpServer(store, "admin", { tools: "all" }, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const restore = (): void => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  Object.assign(process.env, vars);
  let out: T;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out instanceof Promise) return out.finally(restore) as T;
  restore();
  return out;
}

afterEach(() => setProcessWriter(""));

describe("read access log", () => {
  test("an MCP read is logged with writer, tool, namespace, count and a redacted preview; never note text or titles", async () => {
    const store = new Store(":memory:");
    store.create({ namespace: "team", title: "TITLE-deploy-window", body: BODY });
    store.create({ namespace: "team", title: "TITLE-deploy-rollback", body: BODY });
    const c = await connect(store, { label: "bot-a", authed: true });
    const r: any = await c.callTool({ name: "state_search", arguments: { namespace: "team", query: `deploy ${SECRET}` } });
    assert.ok(!r.isError);
    await c.callTool({ name: "state_list", arguments: { namespace: "team" } });
    const log = store.accessLog();
    assert.equal(log.length, 2);
    const search = log.find((e) => e.tool === "state_search")!;
    assert.equal(search.writer, "bot-a");
    assert.equal(search.namespaces, "team");
    assert.match(search.query, /^deploy .*\[REDACTED/);
    assert.ok(!search.query.includes("sk9f8e7d6c5b4a3z2y1x"), "the secret is not in the log");
    const list = log.find((e) => e.tool === "state_list")!;
    assert.equal(list.results, 2);
    const raw = JSON.stringify(store.captureDb().prepare("SELECT * FROM access_log").all());
    assert.ok(!raw.includes("BODYTEXT") && !raw.includes("TITLE-"), "no note text or title in any column");
    await c.close();
    store.close();
  });

  test("the preview is one line of at most 120 characters, and a failed read is not logged", async () => {
    const store = new Store(":memory:");
    const c = await connect(store, { label: "bot-a", authed: true });
    await c.callTool({ name: "state_search", arguments: { query: "abcdefghi\nb ".repeat(25) } });
    assert.equal(store.accessLog()[0].query.length, 120);
    assert.ok(!store.accessLog()[0].query.includes("\n"));
    const bad: any = await c.callTool({ name: "state_read", arguments: { id: 999 } });
    assert.ok(bad.isError);
    assert.equal(store.accessLog().filter((e) => e.tool === "state_read").length, 0);
    await c.close();
    store.close();
  });

  test("retention: the hourly sweep drops rows older than MONOMEM_ACCESS_LOG_DAYS", () => {
    const store = new Store(":memory:");
    store.logAccess({ tool: "state_list", results: 1 });
    withEnv({ MONOMEM_ACCESS_LOG_DAYS: "30" }, () => {
      store.sweepExpired(Date.now() + 29 * 86_400_000);
      assert.equal(store.accessLog().length, 1);
      store.sweepExpired(Date.now() + 31 * 86_400_000);
      assert.equal(store.accessLog().length, 0);
    });
    store.close();
  });

  test("MONOMEM_ACCESS_LOG_DAYS=0 turns it off", async () => {
    const store = new Store(":memory:");
    await withEnv({ MONOMEM_ACCESS_LOG_DAYS: "0" }, async () => {
      const c = await connect(store, { label: "bot-a", authed: true });
      await c.callTool({ name: "state_list", arguments: {} });
      await c.close();
    });
    assert.equal(store.accessLog().length, 0);
    store.close();
  });

  test("the preview is sealed at rest when encryption is on, and opens again after decrypt", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-acc-enc-"));
    try {
      const db = join(dir, "state.db");
      let s = new Store(db);
      s.logAccess({ tool: "state_search", query: "MARK-before", results: 0 });
      const key = ensureKey(dir);
      s.encryptAll(key);
      s.logAccess({ tool: "state_search", query: "MARK-after", results: 0 });
      const stored = () => (s.captureDb().prepare("SELECT query FROM access_log").all() as Array<{ query: string }>).map((r) => r.query);
      assert.ok(stored().every((q) => !q.includes("MARK")), "both previews sealed");
      assert.deepEqual(s.accessLog().map((e) => e.query).sort(), ["MARK-after", "MARK-before"]);
      s.decryptAll(key);
      assert.ok(stored().every((q) => q.startsWith("MARK")));
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no MCP tool exposes the log or the flood guard", async () => {
    const store = new Store(":memory:");
    const c = await connect(store);
    for (const t of (await c.listTools()).tools) {
      assert.doesNotMatch(t.name, /access|flood|resume|pause/i);
      assert.doesNotMatch(JSON.stringify(t.inputSchema), /access_log|flood/i, t.name);
    }
    await c.close();
    store.close();
  });

  test("REST: reads are logged with the token label; GET /access, /flood and POST /flood/resume are admin-only", async () => {
    const store = new Store(":memory:");
    store.create({ namespace: "team", title: "t", body: BODY });
    const ADMIN = "tok-admin-1234567890abcdef";
    const READ = "tok-read-1234567890abcdef";
    const server = createApiServer(store, [
      { token: ADMIN, scope: "admin", label: "op" },
      { token: READ, scope: "read", label: "reader" },
    ]);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
    try {
      assert.equal((await fetch(`${base}/search?q=${encodeURIComponent(SECRET)}&namespace=team`, { headers: H(READ) })).status, 200);
      assert.equal((await fetch(`${base}/relevant`, { method: "POST", headers: H(READ), body: JSON.stringify({ message: "what is t" }) })).status, 200);
      for (const p of ["/access", "/flood"]) assert.equal((await fetch(base + p, { headers: H(READ) })).status, 403, p);
      assert.equal((await fetch(`${base}/flood/resume`, { method: "POST", headers: H(READ), body: "{}" })).status, 403);
      const res = await fetch(`${base}/access?writer=reader&since=1h`, { headers: H(ADMIN) });
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.deepEqual(body.entries.map((e: any) => e.tool).sort(), ["GET /search", "POST /relevant"]);
      const search = body.entries.find((e: any) => e.tool === "GET /search");
      assert.equal(search.writer, "reader");
      assert.ok(!search.query.includes("sk9f8e7d6c5b4a3z2y1x"));
      assert.equal(body.entries.find((e: any) => e.tool === "POST /relevant").query, "what is t");
      // Reading the log is not itself a logged read.
      assert.equal(store.accessLog({ writer: "op" }).length, 0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("CLI: monomem access prints the log; flood and resume work", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-acc-cli-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      setProcessWriter("stdio");
      s.logAccess({ tool: "state_search", namespaces: ["team"], query: "deploy window", results: 3 });
      withEnv({ MONOMEM_FLOOD_WRITES_PER_HOUR: "1" }, () => {
        s.create({ title: "one" });
        assert.throws(() => s.create({ title: "two" }), WriterPausedError);
      });
      s.close();
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
      const cli = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), ...args], { env, encoding: "utf8" });
      let r = cli("access", "--writer", "stdio", "--since", "1h");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /stdio\s+state_search\s+3 result\(s\)\s+team\s+"deploy window"/);
      assert.match(r.stdout, /Paused by the flood guard: stdio/);
      assert.match(cli("flood").stdout, /Paused: stdio/);
      // Lifting a pause lowers protection: from a script (no terminal) it is refused and the pause stays.
      r = cli("resume", "stdio");
      assert.equal(r.status, 1);
      assert.match(r.stderr, /person must run it in a terminal/);
      assert.match(cli("flood").stdout, /Paused: stdio/);
      const s2 = new Store(db);
      assert.equal(s2.resumeWriter("stdio"), true);
      s2.close();
      assert.match(cli("flood").stdout, /No writer is paused/);
      assert.equal(cli("resume").status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("schema v17", () => {
  test("a v16 database upgrades: notes kept, access_log and write_rate added, one backup at v16", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-v17-"));
    try {
      const path = join(dir, "state.db");
      const s0 = new Store(path);
      s0.create({ title: "kept" });
      s0.close();
      downgradeTo(path, 16);
      assert.equal(Store.peekSchemaVersion(path), 16);
      const quiet = console.error;
      console.error = () => undefined;
      let s: Store;
      try {
        s = new Store(path);
      } finally {
        console.error = quiet;
      }
      assert.equal(Store.peekSchemaVersion(path), 19);
      assert.equal(Store.peekSchemaVersion(path + ".pre-v19-backup"), 16);
      assert.deepEqual(s.list({}).notes.map((n) => n.title), ["kept"]);
      s.logAccess({ tool: "state_list", results: 1 });
      assert.equal(s.accessLog().length, 1);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flood guard", () => {
  test("trips past the threshold; the paused writer is refused, others are not, the CLI never is", () => {
    const store = new Store(":memory:");
    withEnv({ MONOMEM_FLOOD_WRITES_PER_HOUR: "3" }, () => {
      setProcessWriter("stdio");
      const n = store.create({ title: "a" });
      store.update(n.id, { body: "b" });
      store.create({ title: "c" });
      const quiet = console.error;
      let warned = "";
      console.error = (m: string) => void (warned += m);
      try {
        assert.throws(() => store.create({ title: "d" }), (e: unknown) => e instanceof WriterPausedError && /monomem resume stdio/.test((e as Error).message));
      } finally {
        console.error = quiet;
      }
      assert.match(warned, /flood guard: paused writer "stdio"/);
      assert.deepEqual(store.pausedWriters(), ["stdio"]);
      assert.throws(() => store.update(n.id, { body: "x" }), WriterPausedError);
      assert.throws(() => store.archive(n.id), WriterPausedError);
      assert.equal(store.list({}).notes.length, 2);
      setProcessWriter("runner");
      assert.ok(store.create({ title: "other writer" }));
      setProcessWriter("cli");
      for (let i = 0; i < 6; i++) store.create({ title: `cli ${i}` });
      assert.deepEqual(store.pausedWriters(), ["stdio"]);
      assert.equal(store.resumeWriter("stdio"), true);
      assert.equal(store.resumeWriter("stdio"), false);
      setProcessWriter("stdio");
      assert.ok(store.create({ title: "after resume" }));
    });
    store.close();
  });

  test("MONOMEM_FLOOD_WRITES_PER_HOUR=0 turns it off", () => {
    const store = new Store(":memory:");
    withEnv({ MONOMEM_FLOOD_WRITES_PER_HOUR: "0" }, () => {
      setProcessWriter("stdio");
      for (let i = 0; i < 20; i++) store.create({ title: `n${i}` });
    });
    assert.deepEqual(store.pausedWriters(), []);
    store.close();
  });

  test("an MCP write from a paused token label gets a clear error", async () => {
    const store = new Store(":memory:");
    await withEnv({ MONOMEM_FLOOD_WRITES_PER_HOUR: "1" }, async () => {
      const c = await connect(store, { label: "bot-a", authed: true });
      assert.ok(!((await c.callTool({ name: "state_write", arguments: { title: "one" } })) as any).isError);
      const r: any = await c.callTool({ name: "state_write", arguments: { title: "two" } });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /paused by the flood guard/);
      await c.close();
    });
    assert.deepEqual(store.pausedWriters(), ["bot-a"]);
    store.close();
  });

  test("the pause survives reopening the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-flood-"));
    try {
      const db = join(dir, "state.db");
      let s = new Store(db);
      withEnv({ MONOMEM_FLOOD_WRITES_PER_HOUR: "1" }, () => {
        setProcessWriter("stdio");
        s.create({ title: "one" });
        assert.throws(() => s.create({ title: "two" }), WriterPausedError);
      });
      s.close();
      s = new Store(db);
      assert.equal(SCHEMA_VERSION, 19);
      assert.deepEqual(s.pausedWriters(), ["stdio"]);
      setProcessWriter("stdio");
      assert.throws(() => s.create({ title: "three" }), WriterPausedError, "still paused at the default threshold");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
