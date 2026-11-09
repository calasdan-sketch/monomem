import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// Expert round 2: names refused at write time, setup pins MONOMEM_HOME everywhere, edit cleans up, a damaged database is
// reported, health's audit check survives rotation, recall wording and meter, MCP argument drift, writer identity, CLI
// output, and audit lines only for committed writes.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store, ValidationError } from "../src/store.js";
import { renderAudit } from "../src/audit-view.js";
import { PROJECT_ROOT, resolveDataDir, resolveTokens } from "../src/config.js";
import { DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";
import { runHealth, type HealthOpts } from "../src/health.js";
import { backupStore } from "../src/backup.js";
import { injectContext } from "../src/context-inject.js";
import { runRecall } from "../src/recall.js";
import { meterStats } from "../src/meter.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { setProcessWriter } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import type { DrillReport } from "../src/drill.js";

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
/** The CLI against a throwaway data folder (never the real one). */
const cli = (home: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home, NO_COLOR: "1", ...env }, timeout: 60_000 });
const drillOk = async (): Promise<DrillReport> => ({ notes: 0, attacks: 22, rows: [], reached: [], unexpected: [], ok: true, elapsed_ms: 1, approve_first: false });
const withEnv = async <T>(vars: Record<string, string | undefined>, f: () => Promise<T> | T): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return await f();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
};
const toolJson = (r: unknown): Record<string, unknown> => {
  const t = (r as { content: Array<{ text: string }> }).content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};
async function mcp(store: Store, conn: Parameters<typeof createMcpServer>[3] = {}): Promise<Client> {
  const server = createMcpServer(store, "admin", {}, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

describe("1. names a terminal could misprint", () => {
  test("Store refuses a control character in a namespace or tag, a 101-char namespace and the namespace \"*\"", () => {
    const s = new Store(":memory:");
    try {
      for (const input of [{ namespace: "evil\u001b[2J" }, { namespace: "n".repeat(101) }, { namespace: "*" }, { tags: ["a‮b"] }]) {
        assert.throws(() => s.create({ title: "x", ...input }), ValidationError, JSON.stringify(input));
      }
      const ok = s.create({ title: "x", namespace: "n".repeat(100) });
      assert.throws(() => s.update(ok.id, { namespace: "bad\u0007" }), ValidationError);
    } finally {
      s.close();
    }
  });
  test("renderAudit prints a stored namespace and label with no escape character", () => {
    const out = renderAudit([{ ts: "2026-11-09T00:00:00Z", op: "create", namespace: "evil\u001b[2J", label: "x\u001b]0;t\u0007", id: 1 }]);
    assert.ok(!out.includes("\u001b"), out);
    assert.match(out, /evil\?\[2J/);
  });
});

describe("2. setup and MONOMEM_HOME", () => {
  const io = (): SetupIO & { all: () => string } => {
    const l: string[] = [];
    return { interactive: false, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => "", all: () => l.join("\n") };
  };
  const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, ...o });
  function sandbox(): { e: SetupEnv; root: string; home: string; data: string } {
    const root = tmp("om-r2-setup-");
    const home = join(root, "home");
    const data = join(root, "data-home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    return { root, home, data, e: { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: data }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: "/opt/monomem/dist/src/cli.js", version: "2.0.0", now: () => new Date("2026-11-09T12:00:00Z") } };
  }

  test("MONOMEM_HOME and no --db: the Claude Code hook commands name that home's state.db", async () => {
    const s = sandbox();
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ only: ["claude-code"], hook: "yes", capture: "yes" })), 0, out.all());
    const settings = readFileSync(join(s.home, ".claude", "settings.json"), "utf8");
    const want = join(resolve(s.data), "state.db").replace(/\\/g, "/");
    const commands = [...settings.matchAll(/"command":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    assert.ok(commands.length >= 2, settings);
    for (const c of commands) assert.ok(c.includes(`--db "${want}"`), c);
  });

  test("an existing entry with only MONOMEM_CLIENT gets MONOMEM_HOME; --undo takes it out again; another home is a conflict", async () => {
    const s = sandbox();
    const file = join(s.home, ".cursor", "mcp.json");
    mkdirSync(join(s.home, ".cursor"), { recursive: true });
    const before = JSON.stringify({ mcpServers: { monomem: { command: "node", args: ["cli.js", "mcp"], env: { MONOMEM_CLIENT: "cursor" } } } }, null, 2);
    writeFileSync(file, before);
    assert.equal(await runSetup(s.e, io(), opts({ only: ["cursor"] })), 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcpServers.monomem.env, { MONOMEM_CLIENT: "cursor", MONOMEM_HOME: resolve(s.data) });
    assert.equal(await runSetup(s.e, io(), opts({ undo: true })), 0);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).mcpServers.monomem.env.MONOMEM_HOME, undefined);
    writeFileSync(file, JSON.stringify({ mcpServers: { monomem: { command: "node", args: ["cli.js", "mcp"], env: { MONOMEM_CLIENT: "cursor", MONOMEM_HOME: join(s.root, "elsewhere") } } } }));
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ only: ["cursor"] })), 1);
    assert.match(out.all(), /uses a different data folder/);
  });

  test("resolveDataDir expands ~/ to the home folder", () => {
    const r = resolveDataDir({ MONOMEM_HOME: "~/x" }, tmp("om-r2-root-"));
    assert.equal(r.dir, join(homedir(), "x"));
  });

  test("connect windsurf prints a real entry with MONOMEM_CLIENT=windsurf and the data folder", () => {
    const home = tmp("om-r2-ws-");
    const r = cli(home, ["connect", "windsurf"]);
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(json.mcpServers.monomem.env.MONOMEM_CLIENT, "windsurf");
    assert.equal(json.mcpServers.monomem.env.MONOMEM_HOME, resolve(home));
    assert.notEqual(json.mcpServers.monomem.command, "monomem");
  });
});

test("3. monomem edit deletes its temp copy when the editor fails", () => {
  const home = tmp("om-r2-edit-");
  const t = tmp("om-r2-edit-tmp-");
  assert.equal(cli(home, ["add", "edit me", "--title", "Edit me"]).status, 0);
  const id = (JSON.parse(cli(home, ["ls", "--json"]).stdout) as Array<{ id: number }>)[0].id;
  const r = cli(home, ["edit", String(id)], { EDITOR: `"${process.execPath}" -e "process.exit(2)"`, VISUAL: "", TMP: t, TEMP: t, TMPDIR: t });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not start or did not finish normally/);
  assert.deepEqual(readdirSync(t).filter((f) => f.startsWith("monomem-edit-")), []);
});

describe("4. a damaged database is reported", () => {
  test("search exits non-zero with the restore hint; doctor prints a fail line, not 'database OK'", () => {
    const home = tmp("om-r2-corrupt-");
    const db = join(home, "state.db");
    const s = new Store(db);
    for (let i = 0; i < 40; i++) s.create({ title: `note ${i} about deploys`, body: "deploy staging ".repeat(150) });
    s.close();
    const fd = openSync(db, "r+");
    try {
      writeSync(fd, Buffer.alloc(4096 * 6, 0x5a), 0, 4096 * 6, 4096 * 2); // pages 3-8 become garbage
    } finally {
      closeSync(fd);
    }
    const r = cli(home, ["search", "deploy"]);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /monomem restore/);
    const d = cli(home, ["doctor"]);
    assert.doesNotMatch(d.stdout, /database OK/);
    assert.match(d.stdout, /FAIL/);
  });
});

describe("5. health's audit check", () => {
  test("rotation (MONOMEM_AUDIT_MAX_BYTES=3000, KEEP=1) is not reported as tampering; a backup carries no health_audit_seen", async () => {
    const dir = tmp("om-r2-health-");
    const dbPath = join(dir, "state.db");
    const auditPath = join(dir, "audit.log");
    const opts: HealthOpts = { dbPath, dataDir: dir, bindHost: "127.0.0.1", settingsPath: join(dir, "s.json"), pluginsPath: join(dir, "p.json"), auditPath, drill: drillOk };
    await withEnv({ MONOMEM_AUDIT_LOG: auditPath, MONOMEM_AUDIT_MAX_BYTES: "3000", MONOMEM_AUDIT_KEEP: "1" }, async () => {
      const s = new Store(dbPath);
      for (let i = 0; i < 10; i++) s.create({ title: `a${i}` });
      s.close();
      const first = (await runHealth(opts)).checks.find((c) => c.id === "audit")!;
      assert.equal(first.status, "ok", first.text);
      const s2 = new Store(dbPath);
      for (let i = 0; i < 30; i++) s2.create({ title: `b${i}` });
      const second = (await runHealth(opts)).checks.find((c) => c.id === "audit")!;
      assert.equal(second.status, "ok", second.text);
      assert.doesNotMatch(second.text, /edited or replaced|removed/);
      const out = join(dir, "bk");
      backupStore(s2, dbPath, out);
      s2.close();
      const copy = new DatabaseSync(join(out, "state.db"), { readOnly: true });
      try {
        assert.equal(copy.prepare("SELECT value FROM _meta WHERE key = 'health_audit_seen'").get(), undefined);
      } finally {
        copy.close();
      }
    });
  });

  test("the audit-write check warns, counting this process's failed audit entries", async () => {
    const dir = tmp("om-r2-auditw-");
    writeFileSync(join(dir, "blocker"), "a file, so nothing can be created under it");
    const auditPath = join(dir, "blocker", "audit.log");
    const dbPath = join(dir, "state.db");
    await withEnv({ MONOMEM_AUDIT_LOG: auditPath }, async () => {
      const s = new Store(dbPath);
      s.create({ title: "audited" });
      s.close();
      const r = await runHealth({ dbPath, dataDir: dir, bindHost: "127.0.0.1", settingsPath: join(dir, "s.json"), pluginsPath: join(dir, "p.json"), auditPath, drill: drillOk });
      const w = r.checks.find((c) => c.id === "audit-write");
      assert.ok(w, JSON.stringify(r.checks.map((c) => c.id)));
      assert.equal(w!.status, "warn");
      assert.match(w!.text, /could not be written by this process|cannot be written/);
    });
  });
});

describe("6. session-start recall", () => {
  test("the footer names state_read id= by default; state_read takes ids as an alias", async () => {
    const s = new Store(":memory:");
    try {
      for (let i = 0; i < 3; i++) s.create({ title: `deploy note ${i}`, body: "how we deploy" });
      const text = await withEnv({ MONOMEM_TOOLS: undefined }, () => injectContext(s, { signals: {} }));
      assert.match(text, /Open any with state_read id=N \(/);
      const client = await mcp(s);
      const r = toolJson(await client.callTool({ name: "state_read", arguments: { ids: [1] } }));
      assert.equal((r.note as { id: number }).id, 1);
      await client.close();
    } finally {
      s.close();
    }
  });

  test("Claude Code's recall leaves out notes imported from CLAUDE.md; other apps still get them", async () => {
    const dir = tmp("om-r2-recall-");
    const dbPath = join(dir, "state.db");
    const s = new Store(dbPath);
    s.create({ title: "From CLAUDE.md: use pnpm", tags: ["claude-md"] });
    s.create({ title: "Regular note about pnpm" });
    s.close();
    const cc = await withEnv({ CLAUDECODE: "1", CLAUDE_PROJECT_DIR: undefined }, () => runRecall({ dbPath, cwd: dir }));
    assert.match(cc, /Regular note/);
    assert.doesNotMatch(cc, /From CLAUDE\.md/);
    const other = await withEnv({ CLAUDECODE: undefined, CLAUDE_PROJECT_DIR: undefined }, () => runRecall({ dbPath, cwd: dir }));
    assert.match(other, /From CLAUDE\.md/);
  });

  test("two recalls for one session add the 'saved' estimate once", async () => {
    const s = new Store(":memory:");
    try {
      for (let i = 0; i < 4; i++) s.create({ title: `long note ${i}`, body: "word ".repeat(1500) });
      await injectContext(s, { signals: {}, sessionId: "s1" });
      const once = meterStats(s).totals;
      await injectContext(s, { signals: {}, sessionId: "s1" });
      const twice = meterStats(s).totals;
      assert.ok(once.saved_tokens > 0);
      assert.equal(twice.saved_tokens, once.saved_tokens);
      assert.equal(twice.injections, once.injections + 1, "the injection itself is still counted");
    } finally {
      s.close();
    }
  });

  test("the drill's TERM check holds even when a note guessed the block id", async () => {
    const { RENDER_ATTACKS } = await import("../src/drill.js");
    assert.equal(RENDER_ATTACKS.find((a) => a.id === "TERM")!.blocked(), true);
  });
});

describe("7. MCP argument drift", () => {
  test("string ids and limits, number/boolean facts, facts as JSON, comma tags, a body without a title, read in parts", async () => {
    const s = new Store(":memory:");
    const client = await mcp(s);
    try {
      const w = await client.callTool({ name: "state_write", arguments: { title: "ports", body: "x", facts: { api_port: 8080, use_cache: true }, tags: "deploy,ci" } });
      assert.ok(!(w as { isError?: boolean }).isError, JSON.stringify(w));
      const note = s.read(1)!;
      assert.ok(note.tags.includes("deploy") && note.tags.includes("ci"), note.tags.join(","));
      assert.ok(note.tags.some((t) => /api_port.*8080/.test(t)) && note.tags.some((t) => /use_cache.*true/.test(t)), note.tags.join(","));
      assert.ok(!(await client.callTool({ name: "state_write", arguments: { title: "j", facts: '{"region":"eu"}' } }) as { isError?: boolean }).isError);
      assert.equal((toolJson(await client.callTool({ name: "state_read", arguments: { id: "1" } })).note as { title: string }).title, "ports");
      assert.ok(!(await client.callTool({ name: "state_search", arguments: { query: "ports", limit: "5" } }) as { isError?: boolean }).isError);
      const gen = toolJson(await client.callTool({ name: "state_write", arguments: { body: "my staging server is on port 8443" } }));
      assert.equal((gen.note as { title: string }).title, "my staging server is on port 8443");
      assert.match(String(gen.title_generated), /made from the body's first line/);
      const big = "lorem ipsum dolor ".repeat(6000).slice(0, 100_000);
      const id = s.create({ title: "big", body: big }).id;
      const part = toolJson(await client.callTool({ name: "state_read", arguments: { id, max_chars: 30000 } })).note as { body: string; body_truncated: boolean; body_chars: number; next_offset: number };
      assert.equal(part.body.length, 30000);
      assert.equal(part.body_truncated, true);
      assert.equal(part.body_chars, 100_000);
      assert.equal(part.next_offset, 30000);
    } finally {
      await client.close();
      s.close();
    }
  });
});

describe("8. writer identity", () => {
  test("catch_up {} keeps one marker per app: two stdio apps on one store both see a new note", async () => {
    const s = new Store(":memory:");
    const a = await mcp(s, { local: true });
    const b = await mcp(s, { local: true });
    const as = async (w: "stdio:app-a" | "stdio:app-b", c: Client) => {
      setProcessWriter(w);
      return toolJson(await c.callTool({ name: "catch_up", arguments: {} }));
    };
    try {
      await as("stdio:app-a", a);
      await as("stdio:app-b", b);
      s.create({ title: "new for everyone" });
      const ca = await as("stdio:app-a", a);
      const cb = await as("stdio:app-b", b);
      for (const c of [ca, cb]) assert.match(JSON.stringify(c.changes), /new for everyone/);
    } finally {
      await a.close();
      await b.close();
      s.close();
    }
  });

  test("two tokens with one label (any case) are both refused", () => {
    const L = (n: string): string => n.padEnd(32, "-");
    const list = withEnvSync({ MONOMEM_TOKENS: JSON.stringify([{ token: L("A1"), scope: "write", label: "alice" }, { token: L("A2"), scope: "write", label: "Alice" }, { token: L("B"), scope: "write", label: "bob" }]) }, () => resolveTokens());
    const toks = list.map((t) => t.token);
    assert.ok(!toks.includes(L("A1")) && !toks.includes(L("A2")));
    assert.ok(toks.includes(L("B")));
  });

  test("POST /capture: a second token posting to another writer's session gets 409", async () => {
    const s = new Store(":memory:");
    const A = "a".repeat(40), B = "b".repeat(40);
    const server = createApiServer(s, [{ token: A, scope: "write", label: "a" }, { token: B, scope: "write", label: "b" }]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (tok: string) => fetch(`${base}/capture`, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify({ event: "user-prompt", session_id: "s1", input: "hi" }) });
    try {
      assert.equal((await post(A)).status, 202);
      assert.equal((await post(A)).status, 202);
      assert.equal((await post(B)).status, 409);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });

  test("stdio with MONOMEM_STDIO_MAX_SENSITIVITY still stamps stdio:<app>", async () => {
    const home = tmp("om-r2-stdio-");
    const env = { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home, MONOMEM_STDIO_MAX_SENSITIVITY: "internal", MONOMEM_CLIENT: "claude-code" } as Record<string, string>;
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "ignore" }));
    try {
      const w = toolJson(await client.callTool({ name: "state_write", arguments: { title: "stamped" } }));
      assert.equal((w.note as { written_by: string }).written_by, "stdio:claude-code");
    } finally {
      await client.close();
    }
  });
});

describe("9. CLI output", () => {
  test("search --json is JSON; --limit 0 is refused; show prints a multi-line body line by line", () => {
    const home = tmp("om-r2-cli-");
    assert.equal(cli(home, ["add", "line one\nline two\u001b[2J", "--title", "Deploy steps"]).status, 0);
    const j = cli(home, ["search", "deploy steps", "--json"]);
    assert.equal(j.status, 0, j.stderr);
    const parsed = JSON.parse(j.stdout) as { keywords: string[]; results: Array<{ id: number; namespace: string; title: string }> };
    assert.ok(Array.isArray(parsed.keywords));
    assert.equal(parsed.results[0].title, "Deploy steps");
    const bad = cli(home, ["search", "deploy", "--limit", "0"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--limit must be a whole number, 1 or more\./);
    const show = cli(home, ["show", String(parsed.results[0].id)]).stdout;
    assert.match(show, /\nline one\nline two\?\[2J/);
    assert.ok(!show.includes("\u001b"));
    const ns = cli(home, ["ls", "--ns", "nope"]).stdout;
    assert.match(ns, /No notes in namespace "nope"\. Namespaces in use: default/);
  });
});

describe("10. audit lines only for committed writes", () => {
  test("a transaction that throws leaves no 'create' lines for the rolled-back notes", async () => {
    const dir = tmp("om-r2-audit-");
    const auditPath = join(dir, "audit.log");
    await withEnv({ MONOMEM_AUDIT_LOG: auditPath }, () => {
      const s = new Store(join(dir, "state.db"));
      try {
        s.create({ title: "kept" });
        assert.throws(() =>
          s.transaction(() => {
            s.create({ title: "rolled back 1" });
            s.create({ title: "rolled back 2" });
            throw new Error("boom");
          })
        );
        const ids = new Set(s.list({ limit: 50 }).notes.map((n) => n.id));
        const creates = readFileSync(auditPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { op: string; id?: number }).filter((e) => e.op === "create");
        assert.ok(creates.length >= 1);
        for (const c of creates) assert.ok(ids.has(c.id!), `audit line for #${c.id}, which is not in the database`);
      } finally {
        s.close();
      }
    });
  });

  test("during a large import, a write from another process finishes within a few seconds", async () => {
    const home = tmp("om-r2-import-");
    const s = new Store(join(home, "state.db"));
    try {
      const notes = Array.from({ length: 3000 }, (_, i) => ({ title: `imported ${i}`, body: "some text to import ".repeat(10) }));
      const importing = s.importNotes(notes as never, { deferEdges: true } as never);
      await new Promise((r) => setTimeout(r, 30));
      const started = Date.now();
      const child = spawn(process.execPath, [CLI, "add", "written during the import"], { env: { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home }, stdio: "ignore" });
      const code = await new Promise<number | null>((r) => child.on("exit", r));
      const took = Date.now() - started;
      await importing;
      assert.equal(code, 0);
      assert.ok(took < 4000, `the other writer waited ${took} ms`);
    } finally {
      s.close();
    }
  });
});

function withEnvSync<T>(vars: Record<string, string | undefined>, f: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return f();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}
void existsSync;
