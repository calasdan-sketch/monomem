import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// Expert round 3: write tokens cannot backdate or schedule removal of others' notes, strict MCP ids, import refuses
// unsafe names, MONOMEM_HOME guardrails, hard delete clears the WAL, stdio flushes on close, stale app entries,
// honest multi-reads and archived notes, ignored MCP arguments, recall ids and piped edit.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, ValidationError } from "../src/store.js";
import { PROJECT_ROOT } from "../src/config.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { createApiServer } from "../src/api.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const roots: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  roots.push(d);
  return d;
};
afterEach(() => {
  setProcessWriter("");
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const cli = (home: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home, NO_COLOR: "1", ...(opts.env ?? {}) },
    timeout: 60_000,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
const toolJson = (r: unknown): Record<string, unknown> => {
  const t = (r as { content: Array<{ text: string }> }).content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};
const toolText = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0].text;
async function mcp(store: Store, conn: Parameters<typeof createMcpServer>[3] = {}): Promise<Client> {
  const server = createMcpServer(store, "admin", {}, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}
async function api(store: Store, tokens: Parameters<typeof createApiServer>[1]) {
  const server = createApiServer(store, tokens);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (tok: string, method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const as = <T>(label: string, admin: boolean, f: () => T): T => actorStore.run({ label, authed: true, canDeclassify: admin }, f);

describe("1. write tokens cannot fake history or schedule removal of others' notes", () => {
  test("write token POST created_at -> 400 and nothing stored; admin import keeps 2019; future refused", async () => {
    const s = new Store(":memory:");
    const W = "w".repeat(40), A = "a".repeat(40);
    const srv = await api(s, [{ token: W, scope: "write", label: "w" }, { token: A, scope: "admin", label: "boss" }]);
    try {
      const r = await srv.call(W, "POST", "/notes", { title: "old", created_at: "2019-01-01T00:00:00.000Z" });
      assert.equal(r.status, 400);
      assert.match(((await r.json()) as { error: string }).error, /admin/);
      assert.equal(s.list({}).notes.length, 0);
      const imp = await srv.call(A, "POST", "/import", { notes: [{ title: "kept", created_at: "2019-01-01T00:00:00.000Z" }, { title: "future", created_at: new Date(Date.now() + 3_600_000).toISOString() }] });
      assert.equal(imp.status, 200, await imp.clone().text());
      const kept = s.list({}).notes.find((n) => n.title === "kept");
      assert.equal(kept?.created_at, "2019-01-01T00:00:00.000Z");
      assert.ok(!s.list({}).notes.some((n) => n.title === "future"));
      const fut = await srv.call(A, "POST", "/notes", { title: "f", created_at: new Date(Date.now() + 3_600_000).toISOString() });
      assert.equal(fut.status, 400);
    } finally {
      await srv.close();
      s.close();
    }
  });

  test("carol cannot set forget_after on alice's note; alice can on her own; admin can", () => {
    const s = new Store(":memory:");
    try {
      const n = as("alice", false, () => s.create({ title: "alice's" }));
      assert.throws(() => as("carol", false, () => s.update(n.id, { forget_after: 1 })), (e: Error) => e instanceof ValidationError && /'admin' scope/.test(e.message));
      assert.ok(as("alice", false, () => s.update(n.id, { forget_after: 1 }))?.expires_at);
      assert.ok(as("boss", true, () => s.update(n.id, { forget_after: 2 }))?.expires_at);
      assert.ok(as("carol", false, () => s.update(n.id, { forget_after: 0 }))); // clearing a deadline is harmless
      // Editing the body does not make the note carol's: ownership is created_by, not written_by.
      as("carol", false, () => s.update(n.id, { body: "carol edited this" }));
      assert.throws(() => as("carol", false, () => s.update(n.id, { forget_after: 1 })), (e: Error) => e instanceof ValidationError && /'admin' scope/.test(e.message));
    } finally {
      s.close();
    }
  });

  test("sweepExpired writes one audit line per archived note", () => {
    const home = tmp("om-r3-sweep-");
    const log = join(home, "audit.log");
    const prev = process.env.MONOMEM_AUDIT_LOG;
    process.env.MONOMEM_AUDIT_LOG = log;
    const s = new Store(":memory:");
    try {
      const a = s.create({ title: "a", forget_after: 1 });
      const b = s.create({ title: "b", forget_after: 1 });
      assert.equal(s.sweepExpired(Date.now() + 2 * 86_400_000), 2);
      const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.op === "sweep-expire");
      assert.deepEqual(lines.map((l) => l.id).sort(), [a.id, b.id].sort());
    } finally {
      s.close();
      if (prev === undefined) delete process.env.MONOMEM_AUDIT_LOG;
      else process.env.MONOMEM_AUDIT_LOG = prev;
    }
  });
});

describe("2. strict id coercion in MCP tools", () => {
  test("{id:'5'} reads #5; true, null, '', [5] are validation errors and state_delete {id:true} archives nothing", async () => {
    const s = new Store(":memory:");
    try {
      for (let i = 1; i <= 5; i++) s.create({ title: `n${i}` });
      const client = await mcp(s);
      const ok = toolJson(await client.callTool({ name: "state_read", arguments: { id: "5" } }));
      assert.equal((ok.note as { id: number }).id, 5);
      for (const id of [true, null, "", [5]]) {
        const r = (await client.callTool({ name: "state_read", arguments: { id } })) as { isError?: boolean };
        assert.equal(r.isError, true, JSON.stringify(id));
      }
      const del = (await client.callTool({ name: "state_delete", arguments: { id: true } })) as { isError?: boolean };
      assert.equal(del.isError, true);
      assert.equal(s.list({ archivedOnly: true }).notes.length, 0);
      await client.close();
    } finally {
      s.close();
    }
  });
});

describe("3. import refuses reserved and unsafe names", () => {
  test("the three probe rows are rejected; a normal row in the same batch is stored", async () => {
    const s = new Store(":memory:");
    try {
      const report: { quarantined: Array<{ title: string; quarantineId: number }>; rejected: Array<{ title: string; error: string }> } = { quarantined: [], rejected: [] };
      await s.importNotes(
        [
          { title: "esc", namespace: "imp\u001b[31m", tags: ["a\u202eb"] },
          { title: "star", namespace: "*" },
          { title: "long", namespace: "n".repeat(300) },
          { title: "fine", namespace: "work" },
        ],
        { report }
      );
      assert.deepEqual(report.rejected.map((r) => r.title).sort(), ["esc", "long", "star"]);
      assert.deepEqual(s.list({ namespace: "work" }).notes.map((n) => n.title), ["fine"]);
    } finally {
      s.close();
    }
  });
});

describe("4. MONOMEM_HOME guardrails and first-run token race", () => {
  test("blank, quoted, %TEMP% and $HOME values", async () => {
    const { resolveDataDir } = await import("../src/config.js");
    const root = tmp("om-r3-home-");
    assert.throws(() => resolveDataDir({ MONOMEM_HOME: "  " }, root), /MONOMEM_HOME is set but empty/);
    assert.throws(() => resolveDataDir({ MONOMEM_HOME: "", ONEMEMORY_HOME: join(root, "x") }, root), /MONOMEM_HOME is set but empty/);
    assert.throws(() => resolveDataDir({ ONEMEMORY_HOME: "" }, root), /ONEMEMORY_HOME is set but empty/);
    assert.deepEqual(resolveDataDir({ MONOMEM_HOME: `"${join(root, "q")}"` }, root), { dir: join(root, "q"), why: "env" });
    assert.throws(() => resolveDataDir({ MONOMEM_HOME: "%TEMP%\\mm" }, root), /MONOMEM_HOME=%TEMP%\\mm is not a full path/);
    assert.throws(() => resolveDataDir({ MONOMEM_HOME: "$HOME/.monomem" }, root), /is not a full path/);
    assert.throws(() => resolveDataDir({ MONOMEM_HOME: "${HOME}/.monomem" }, root), /is not a full path/);
  });

  test("concurrent first runs all return the token file's value", async () => {
    const home = tmp("om-r3-tok-");
    const { spawn } = await import("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const config = pathToFileURL(join(PROJECT_ROOT, "dist", "src", "config.js")).href;
    const code = `import(${JSON.stringify(config)}).then((m) => process.stdout.write(m.resolveToken()))`;
    const env = { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home } as Record<string, string>;
    delete env.MONOMEM_TOKEN;
    const outs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<string>((res, rej) => {
            const c = spawn(process.execPath, ["-e", code], { env });
            let o = "";
            c.stdout.on("data", (d) => (o += d));
            c.on("exit", (st) => (st === 0 ? res(o) : rej(new Error(`exit ${st}`))));
          })
      )
    );
    const file = readFileSync(join(home, ".token"), "utf8").trim();
    assert.ok(file.length >= 32);
    for (const o of outs) assert.equal(o, file);
  });
});

describe("5. hard delete does not leave plaintext in the WAL", () => {
  test("with a second Store open and idle, the deleted word is not in state.db-wal", () => {
    const dir = tmp("om-r3-wal-");
    const db = join(dir, "state.db");
    const a = new Store(db);
    const b = new Store(db);
    try {
      const word = "zebracorn" + Date.now();
      const n = a.create({ title: "secret", body: `the word is ${word}` });
      b.list({}); // the other connection has read, then gone idle
      assert.equal(a.delete(n.id), true);
      let wal = "";
      try {
        wal = readFileSync(`${db}-wal`).toString("latin1");
      } catch {
        /* no WAL file at all is fine */
      }
      assert.ok(!wal.includes(word), "deleted text left in the WAL");
      assert.equal(a.checkpointWal(), true);
    } finally {
      b.close();
      a.close();
    }
  });
});

describe("6. stdio flushes on normal close; change log pruned", () => {
  test("ending stdin closes the store: the read is counted", async () => {
    const home = tmp("om-r3-stdio-");
    const env = { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home } as Record<string, string>;
    const db = join(home, "state.db");
    const seed = new Store(db);
    seed.create({ title: "one" });
    seed.close();
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "ignore"] });
    const send = (m: unknown): void => void child.stdin.write(JSON.stringify(m) + "\n");
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const until = async (re: RegExp): Promise<void> => {
      for (let i = 0; i < 200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    };
    const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await until(/"id":1/);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "state_read", arguments: { id: 1 } } });
    await until(/"id":2/);
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r("timeout"), 10_000))]);
    if (code === "timeout") child.kill();
    assert.equal(code, 0);
    const after = new Store(db);
    try {
      assert.equal(after.read(1)?.access_count, 1);
    } finally {
      after.close();
    }
  });

  test("stdioSweep runs the expiry sweep and purgeChangeLog, and logs instead of throwing", async () => {
    const { stdioSweep } = await import("../src/mcp-server-core.js");
    const calls: string[] = [];
    const fake = {
      sweepExpired: () => void calls.push("sweep"),
      purgeChangeLog: () => {
        calls.push("purge");
        throw new Error("busy");
      },
    } as unknown as Store;
    const logs: string[] = [];
    stdioSweep(fake, (m) => void logs.push(m));
    assert.deepEqual(calls, ["sweep", "purge"]);
    assert.match(logs.join("\n"), /change-log purge failed: busy/);
  });
});

describe("7. setup/doctor/health catch stale and version-mismatched app entries", () => {
  const io = () => {
    const l: string[] = [];
    return { interactive: false, out: (x: string) => void l.push(x), err: (x: string) => void l.push(x), ask: async () => "", all: () => l.join("\n") };
  };
  async function sandbox(version = "1.3.0") {
    const { DEFAULT_OPTIONS } = await import("../src/setup.js");
    const root = tmp("om-r3-setup-");
    const home = join(root, "home");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const e = { home, platform: process.platform, env: { HOME: home }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version, now: () => new Date("2026-11-09T12:00:00Z") };
    const db = join(root, "data", "state.db");
    const opts = { ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, only: ["cursor"], db } as typeof DEFAULT_OPTIONS;
    const file = join(home, ".cursor", "mcp.json");
    return { root, home, e, opts, db, file, write: (entry: unknown) => writeFileSync(file, JSON.stringify({ mcpServers: { monomem: entry } }, null, 2)) };
  }

  test("a missing cli.js is rewritten with the reason; an old npx pin too; health warns", async () => {
    const { runSetup, appEntryProblems } = await import("../src/setup.js");
    const { runHealth } = await import("../src/health.js");
    const s = await sandbox();
    const gone = join(s.root, "nope", "cli.js");
    s.write({ command: process.execPath, args: [gone, "mcp"], env: { MONOMEM_CLIENT: "cursor", MONOMEM_DB_PATH: s.db } });
    assert.deepEqual(appEntryProblems(s.e), [`Cursor: "monomem" points at ${gone}, which no longer exists`]);
    const h = await runHealth({ dbPath: join(s.root, "none.db"), dataDir: s.root, bindHost: "127.0.0.1", settingsPath: join(s.home, ".claude", "settings.json"), pluginsPath: join(s.root, "p.json"), auditPath: join(s.root, "audit.log"), setupEnv: s.e });
    assert.equal(h.checks.find((c) => c.id === "apps")?.status, "warn");
    const out = io();
    assert.equal(await runSetup(s.e, out, s.opts), 0, out.all());
    assert.match(out.all(), /points at .*nope.*cli\.js, which no longer exists/);
    assert.doesNotMatch(out.all(), /already fine/);
    const now = JSON.parse(readFileSync(s.file, "utf8")).mcpServers.monomem;
    assert.deepEqual(now.args, [CLI, "mcp"]);
    assert.equal(now.env.MONOMEM_CLIENT, "cursor");
    assert.deepEqual(appEntryProblems(s.e), []);

    s.write({ command: "npx", args: ["-y", "monomem@1.2.0", "mcp"], env: { MONOMEM_CLIENT: "cursor", MONOMEM_DB_PATH: s.db } });
    assert.match(appEntryProblems(s.e)[0], /launches monomem 1\.2\.0, this is 1\.3\.0/);
    const out2 = io();
    assert.equal(await runSetup(s.e, out2, s.opts), 0, out2.all());
    assert.match(out2.all(), /launches monomem 1\.2\.0, this is 1\.3\.0/);
  });

  test("pinMismatch expands ~ and ignores case on Windows", async () => {
    const { pinMismatch } = await import("../src/setup.js");
    const home = process.platform === "win32" ? "C:\\Users\\Me" : "/home/me";
    const full = join(home, ".monomem");
    assert.equal(pinMismatch({ home, platform: process.platform }, { MONOMEM_HOME: full }, (k) => (k === "MONOMEM_HOME" ? "~/.monomem" : undefined)), "ok");
    if (process.platform === "win32") assert.equal(pinMismatch({ home, platform: "win32" }, { MONOMEM_HOME: full }, (k) => (k === "MONOMEM_HOME" ? full.toUpperCase() : undefined)), "ok");
  });

  test("health: damaged database wording; Claude Code with only ~/.claude.json", async () => {
    const { runHealth } = await import("../src/health.js");
    const dir = tmp("om-r3-health-");
    const db = join(dir, "state.db");
    writeFileSync(db, "this is not a sqlite database at all, just text".repeat(100));
    const fakeHome = join(dir, "home");
    mkdirSync(fakeHome);
    writeFileSync(join(fakeHome, ".claude.json"), "{}");
    const r = await runHealth({
      dbPath: db,
      dataDir: dir,
      bindHost: "127.0.0.1",
      settingsPath: join(fakeHome, ".claude", "settings.json"),
      pluginsPath: join(dir, "p.json"),
      auditPath: join(dir, "audit.log"),
      setupEnv: { home: fakeHome, platform: process.platform, env: {}, cwd: dir, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "9.9.9", now: () => new Date() },
    });
    const text = (id: string) => r.checks.find((c) => c.id === id)?.text ?? "";
    assert.equal(text("drill"), "not run: the database is damaged (see the Database line)");
    assert.equal(text("hooks"), "Claude Code is connected but has no hooks folder yet; run monomem setup --hook");
  });
});

describe("8. MCP/CLI tell agents the truth about multi-reads and archived notes", () => {
  test("ids of length 3 return notes and missing; archived reads explain; empty search has no banner", async () => {
    const s = new Store(":memory:");
    try {
      const a = s.create({ title: "a", body: "aaa" });
      const b = s.create({ title: "b", body: "bbb" });
      const gone = s.create({ title: "gone", body: "x" });
      s.archive(gone.id);
      const client = await mcp(s);
      const r = toolJson(await client.callTool({ name: "state_read", arguments: { ids: [a.id, b.id, 999] } }));
      assert.deepEqual((r.notes as Array<{ id: number }>).map((n) => n.id), [a.id, b.id]);
      assert.deepEqual(r.missing, [999]);
      const many = toolJson(await client.callTool({ name: "state_read", arguments: { ids: Array.from({ length: 12 }, (_, i) => i + 1) } }));
      assert.deepEqual(many.ignored_ids, [11, 12]);
      for (const name of ["state_read", "state_write", "state_delete"]) {
        const t = toolText(await client.callTool({ name, arguments: name === "state_write" ? { id: gone.id, body: "y" } : { id: gone.id } }));
        assert.match(t, new RegExp(`note ${gone.id} is (already )?archived \\(hidden, not erased\\); a person can restore it with`), name);
      }
      const empty = toolText(await client.callTool({ name: "state_search", arguments: { query: "nothingmatchesthis" } }));
      assert.doesNotMatch(empty, /SECURITY NOTICE/);
      const hit = toolText(await client.callTool({ name: "state_search", arguments: { query: "aaa" } }));
      assert.match(hit, /SECURITY NOTICE/);
      await client.close();
    } finally {
      s.close();
    }
  });

  test("an archived note in a namespace the caller cannot read stays 'no note'", async () => {
    const s = new Store(":memory:");
    try {
      const other = s.create({ title: "theirs", namespace: "other" });
      s.archive(other.id);
      const server = createMcpServer(s, "admin", { namespace: "mine", readsFrom: {} });
      const [c, t] = InMemoryTransport.createLinkedPair();
      const pinned = new Client({ name: "t", version: "1" });
      await Promise.all([pinned.connect(c), server.connect(t)]);
      const txt = toolText(await pinned.callTool({ name: "state_read", arguments: { id: other.id } }));
      assert.match(txt, new RegExp(`no note with id ${other.id}`));
      await pinned.close();
    } finally {
      s.close();
    }
  });

  test("monomem ls --archived lists archived notes with the restore hint", () => {
    const home = tmp("om-r3-ls-");
    const st = new Store(join(home, "state.db"));
    const n = st.create({ title: "old thing" });
    st.archive(n.id);
    st.close();
    const r = cli(home, ["ls", "--archived"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`#${n.id} \\[default\\] old thing\\s+\\(bring back: monomem restore ${n.id}\\)`));
  });
});

describe("9. MCP reports ignored arguments", () => {
  test("text instead of body is refused with the hint; extra keys come back as ignored_arguments; unscoped search says so", async () => {
    const s = new Store(":memory:");
    try {
      s.create({ title: "deploy notes", body: "we deploy on fridays", namespace: "work" });
      const client = await mcp(s);
      const bad = await client.callTool({ name: "state_write", arguments: { text: "remember this" } });
      assert.match(toolText(bad), /a new note needs a title or a body \(you sent `text`; use `body`\)/);
      assert.equal(s.list({}).notes.length, 1);
      const w = toolJson(await client.callTool({ name: "state_write", arguments: { title: "t", content: "x" } }));
      assert.deepEqual(w.ignored_arguments, ["content"]);
      assert.match(String(w.ignored_hint), /did you mean `body`/);
      const q = toolJson(await client.callTool({ name: "state_search", arguments: { query: "deploy", namespaces: ["work"] } }));
      assert.deepEqual(q.ignored_arguments, ["namespaces"]);
      assert.match(String(q.ignored_hint), /NOT limited to a namespace/);
      await client.close();
    } finally {
      s.close();
    }
  });
});

describe("10. recall ids; CLI edit works for non-terminals", () => {
  test("lines start with #id, a body repeating its title is not printed twice, the footer has no id list", async () => {
    const { buildSummary } = await import("../src/recall.js");
    const { injectContext } = await import("../src/context-inject.js");
    const s = new Store(":memory:");
    try {
      for (const t of ["Deploy steps", "Test runner", "Package manager", "Release day"]) s.create({ title: t, body: `${t}: details about ${t.toLowerCase()} for this project` });
      const notes = s.list({}).notes;
      const lines = buildSummary(notes).split("\n").slice(1);
      for (const [i, n] of notes.entries()) {
        assert.ok(lines[i].startsWith(`#${n.id} [${n.title}]`), lines[i]);
        assert.equal(lines[i].split(n.title).length - 1, 1, lines[i]); // the title once, not again from the body
      }
      const old = notes.map((n) => `- [${n.title}]: ${n.body}`).join("\n");
      assert.ok(lines.join("\n").length < old.length, "fewer characters (tokens) than the old rendering");
      const ctx = await injectContext(s, { signals: {} });
      assert.match(ctx, /Open any with (?:state_read id=N|memory_get ids=\[N\])$/);
    } finally {
      s.close();
    }
  });

  test("piped `edit <id> -` updates the note; without '-' and no terminal it exits fast without an editor", () => {
    const home = tmp("om-r3-edit-");
    const st = new Store(join(home, "state.db"));
    const n = st.create({ title: "before", body: "old" });
    st.close();
    const r = cli(home, ["edit", String(n.id), "-"], { input: "after\n\nnew body\n" });
    assert.equal(r.status, 0, r.stderr);
    const marker = join(home, "editor-ran");
    const r2 = cli(home, ["edit", String(n.id)], { env: { EDITOR: `"${process.execPath}" -e "require('fs').writeFileSync('${marker.replace(/\\/g, "/")}','x')"`, VISUAL: "" } });
    assert.notEqual(r2.status, 0);
    assert.match(r2.stderr, /monomem edit \d+ -/);
    assert.throws(() => readFileSync(marker));
    const after = new Store(join(home, "state.db"));
    try {
      const got = after.read(n.id)!;
      assert.equal(got.title, "after");
      assert.equal(got.body, "new body");
    } finally {
      after.close();
    }
  });
});
