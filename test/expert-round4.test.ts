import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// Expert round 4: foreign sync files are unverified and held under approve-first, small correctness fixes, search
// ranking, keyword extraction, a safe uninstall --purge, setup with several legacy entries, cheap change-feed pages,
// import dedupe without created_at, security hardening and docs honesty.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, ValidationError } from "../src/store.js";
import { PROJECT_ROOT } from "../src/config.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { setProcessWriter } from "../src/actor.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";
import { backupStore } from "../src/backup.js";

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
async function mcp(store: Store): Promise<Client> {
  const server = createMcpServer(store, "admin", {}, {});
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

describe("1. sync: notes from other machines are unverified and held under approve-first", () => {
  test("a foreign file is held under approve-first --all; without it the note is live but flagged", async () => {
    setProcessWriter("cli");
    const dir = tmp("om-r4-sync-");
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    const c = new Store(":memory:");
    try {
      a.create({ title: "Deploy steps from laptop", body: "run the zebrafish deploy" });
      exportMarkdown(a, dir);
      b.setApproveFirstAll(true);
      const r = await importMarkdown(b, dir);
      assert.equal(r.foreignHeld, 1);
      assert.equal(b.listQuarantine().length, 1);
      assert.equal(b.search("zebrafish").length, 0, "held, not live");

      const r2 = await importMarkdown(c, dir);
      assert.equal(r2.foreignHeld, 0);
      const n = c.search("zebrafish")[0];
      assert.ok(n);
      assert.equal(c.read(n.id)?.imported_unverified, true);
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });

  test("a file this store wrote still merges live under approve-first", async () => {
    setProcessWriter("cli");
    const dir = tmp("om-r4-sync-own-");
    const a = new Store(":memory:");
    try {
      const n = a.create({ title: "Own note", body: "first text" });
      exportMarkdown(a, dir);
      a.setApproveFirstAll(true);
      const sub = join(dir, readdirSync(dir).find((d) => !d.startsWith("."))!);
      const f = join(sub, readdirSync(sub)[0]);
      writeFileSync(f, readFileSync(f, "utf8").replace("first text", "second text"));
      const r = await importMarkdown(a, dir);
      assert.equal(r.counts.updated, 1, JSON.stringify(r.entries));
      assert.equal(r.foreignHeld, 0);
      assert.equal(a.read(n.id)?.body, "second text");
      assert.equal(a.read(n.id)?.imported_unverified, undefined);
    } finally {
      a.close();
    }
  });
});

describe("2. verifier carryovers", () => {
  test("multi-id state_read dedupes ids and counts one access", async () => {
    const s = new Store(":memory:");
    try {
      const n = s.create({ title: "once", body: "body" });
      const client = await mcp(s);
      const r = toolJson(await client.callTool({ name: "state_read", arguments: { ids: [n.id, n.id, n.id] } }));
      assert.equal((r.notes as unknown[]).length, 1);
      assert.equal(s.read(n.id)?.access_count, 1);
    } finally {
      s.close();
    }
  });

  test("state_read stops reading once max_chars is spent", async () => {
    const s = new Store(":memory:");
    try {
      const a = s.create({ title: "a", body: "x".repeat(50) });
      const b = s.create({ title: "b", body: "y".repeat(50) });
      const client = await mcp(s);
      const r = toolJson(await client.callTool({ name: "state_read", arguments: { ids: [a.id, b.id], max_chars: 50 } }));
      assert.equal((r.notes as unknown[]).length, 1);
      assert.deepEqual(r.not_read_budget_spent, [b.id]);
      assert.equal(s.read(b.id)?.access_count, 0);
    } finally {
      s.close();
    }
  });

  test("backup leaves another run's partial alone", () => {
    const dir = tmp("om-r4-bk-");
    const s = new Store(join(dir, "src", "state.db"));
    try {
      s.create({ title: "n", body: "b" });
      const out = join(dir, "out");
      mkdirSync(out);
      const other = join(out, "state.db.99999abcdef.partial");
      writeFileSync(other, "someone else's copy in progress");
      backupStore(s, join(dir, "src", "state.db"), out);
      assert.ok(existsSync(other));
      assert.ok(existsSync(join(out, "state.db")));
    } finally {
      s.close();
    }
  });

  test("health names a damaged database in the audit line", async () => {
    const { runHealth } = await import("../src/health.js");
    const { audit } = await import("../src/security.js");
    const dir = tmp("om-r4-health-");
    const db = join(dir, "state.db");
    writeFileSync(db, "this is not a sqlite database at all, just text".repeat(100));
    const log = join(dir, "audit.log");
    const prev = process.env.MONOMEM_AUDIT_LOG;
    process.env.MONOMEM_AUDIT_LOG = log;
    try {
      audit({ op: "test.line", label: "cli" });
    } finally {
      if (prev === undefined) delete process.env.MONOMEM_AUDIT_LOG;
      else process.env.MONOMEM_AUDIT_LOG = prev;
    }
    const r = await runHealth({ dbPath: db, dataDir: dir, bindHost: "127.0.0.1", settingsPath: join(dir, "h", ".claude", "settings.json"), pluginsPath: join(dir, "p.json"), auditPath: log });
    assert.match(r.checks.find((c) => c.id === "audit")?.text ?? "", /no breaks \(the database is damaged, so the log length was not checked\)/);
  });

  test("doctor prints a [warn] line for an app entry that points at a removed install", () => {
    const home = tmp("om-r4-doc-");
    const fakeHome = join(home, "userhome");
    mkdirSync(join(fakeHome, ".cursor"), { recursive: true });
    const gone = join(home, "nope", "cli.js");
    writeFileSync(join(fakeHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { monomem: { command: process.execPath, args: [gone, "mcp"] } } }));
    const r = cli(home, ["doctor"], { env: { HOME: fakeHome, USERPROFILE: fakeHome } });
    assert.match(r.stdout, /\[warn\].*points at .*nope.*cli\.js, which no longer exists/);
  });
});

describe("3. search ranking: title and tags weigh more, newest wins ties, cut lists say so", () => {
  test("a title match outranks a body-only mention; equal notes come newest first", async () => {
    const s = new Store(":memory:");
    try {
      const t = s.create({ title: "Release checklist for staging", body: "steps to follow before a release" });
      s.create({ title: "Misc thoughts", body: "the staging server was slow on monday and we talked about lunch plans for a while" });
      assert.equal(s.search("staging")[0].id, t.id);
      for (const p of ["3000", "4000", "5000"]) s.create({ title: "Port setting", body: `the port is ${p}` });
      assert.match(s.search("port setting", { limit: 1 })[0].body, /5000/);
      const client = await mcp(s);
      const r = toolJson(await client.callTool({ name: "state_search", arguments: { query: "port setting", limit: 1 } }));
      assert.match(String((r.results as Array<{ body: string }>)[0].body), /5000/);
      assert.equal(r.more, true);
      const big = toolJson(await client.callTool({ name: "state_search", arguments: { query: "port setting", limit: 500 } }));
      assert.equal(big.limit_capped, 200);
      assert.equal(big.more, undefined);
    } finally {
      s.close();
    }
  });

  test("CLI ls and search say when the list was cut", () => {
    const home = tmp("om-r4-ls-");
    const s = new Store(join(home, "state.db"));
    for (let i = 0; i < 25; i++) s.create({ title: `kiwi note ${i}`, body: "kiwi" });
    s.close();
    const ls = cli(home, ["ls"]);
    assert.match(ls.stdout, /Showing 20 of 25 \(newest first\)\. More: monomem ls --limit 50/);
    const se = cli(home, ["search", "kiwi"]);
    assert.match(se.stdout, /Relevant notes \(5\):/);
    assert.match(se.stdout, /Showing 5; more notes match\. More: --limit 10/);
  });
});

describe("4. keyword extraction keeps short terms that matter", () => {
  test("search CI and search db.ts find their notes; 'go' is exact, not a prefix", async () => {
    const { extractKeywords } = await import("../src/keywords.js");
    assert.deepEqual(extractKeywords("CI"), ["ci"]);
    assert.deepEqual(extractKeywords("db.ts"), ["db", "ts"]);
    assert.deepEqual(extractKeywords("an ox ate my pie on tv"), ["ate", "pie"]);
    const home = tmp("om-r4-kw-");
    const s = new Store(join(home, "state.db"));
    const ci = s.create({ title: "CI pipeline", body: "runs on every push" });
    const db = s.create({ title: "Connection pool fix", body: "the fix is in db.ts" });
    s.create({ title: "golang tips", body: "use gofmt" });
    const { runRelevantSearch } = await import("../src/search-service.js");
    assert.equal((await runRelevantSearch(s, "go", {})).results.length, 0, "a kept short keyword does not prefix-match golang/gofmt");
    s.close();
    assert.match(cli(home, ["search", "CI"]).stdout, new RegExp(`#${ci.id} `));
    assert.match(cli(home, ["search", "db.ts"]).stdout, new RegExp(`#${db.id} `));
  });

  test("request words do not drive relevant search", async () => {
    const { runRelevantSearch } = await import("../src/search-service.js");
    const s = new Store(":memory:");
    try {
      s.create({ title: "Remind script", body: "a cron script that sends a remind email" });
      const d = s.create({ title: "Decision: database migration", body: "we decided to run the database migration on sunday" });
      const r = await runRelevantSearch(s, "can you remind me what we decided about the database migration?", {});
      assert.ok(!r.keywords.includes("remind"));
      assert.equal(r.results[0].id, d.id);
    } finally {
      s.close();
    }
  });
});

describe("5. uninstall --purge only deletes Monomem's files", () => {
  const io = () => ({ interactive: false, out: () => undefined, err: () => undefined, ask: async () => "" });
  const env = (home: string, om: string) => ({ home, platform: process.platform, env: { HOME: home, MONOMEM_HOME: om }, cwd: home, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-09T12:00:00Z") });
  test("a foreign file in MONOMEM_HOME survives; state.db is gone", async () => {
    const { runUninstall } = await import("../src/uninstall.js");
    const root = tmp("om-r4-purge-");
    const om = join(root, "om");
    mkdirSync(om);
    new Store(join(om, "state.db")).close();
    writeFileSync(join(om, ".token"), "x");
    writeFileSync(join(om, "important.txt"), "mine");
    assert.equal(await runUninstall(env(join(root, "home"), om), io(), { dryRun: false, yes: true, purge: true, noBackup: true }), 0);
    assert.ok(existsSync(join(om, "important.txt")));
    assert.ok(!existsSync(join(om, "state.db")));
    assert.ok(!existsSync(join(om, ".token")));
  });
  test("the home folder itself is refused", async () => {
    const { runUninstall, purgeRefusal } = await import("../src/uninstall.js");
    const root = tmp("om-r4-purge-home-");
    writeFileSync(join(root, "important.txt"), "mine");
    assert.equal(await runUninstall(env(root, root), io(), { dryRun: false, yes: true, purge: true, noBackup: true }), 1);
    assert.ok(existsSync(join(root, "important.txt")));
    assert.match(purgeRefusal(process.platform === "win32" ? "C:\\" : "/", root), /root of a drive/);
  });
});

describe("6. setup with several old entries in one file", () => {
  const io = () => {
    const l: string[] = [];
    return { interactive: false, out: (x: string) => void l.push(x), err: (x: string) => void l.push(x), ask: async () => "", all: () => l.join("\n") };
  };
  async function sandbox(extraEnv: Record<string, string> = {}) {
    const { DEFAULT_OPTIONS } = await import("../src/setup.js");
    const root = tmp("om-r4-setup-");
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const e = { home, platform: process.platform, env: { HOME: home, ...extraEnv }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "1.3.0", now: () => new Date("2026-11-09T12:00:00Z") };
    const opts = { ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, only: ["claude-code"], hook: "no" as const, capture: "no" as const } as typeof DEFAULT_OPTIONS;
    return { root, home, e, opts, file: join(home, ".claude.json") };
  }
  test("claude-bridge (with notes) and onememory become one monomem entry", async () => {
    const { runSetup } = await import("../src/setup.js");
    const s = await sandbox();
    const oldDb = join(s.root, "old", "state.db");
    mkdirSync(join(s.root, "old"));
    const st = new Store(oldDb);
    st.create({ title: "kept", body: "x" });
    st.close();
    writeFileSync(s.file, JSON.stringify({ mcpServers: { "claude-bridge": { command: "node", args: ["/x/claude-bridge/dist/src/mcp-stdio.js"], env: { CLAUDE_BRIDGE_DB_PATH: oldDb } }, onememory: { command: "npx", args: ["-y", "onememory-mcp", "mcp"] }, keep: { command: "k" } } }, null, 2));
    const out = io();
    assert.equal(await runSetup(s.e, out, s.opts), 0, out.all());
    const j = JSON.parse(readFileSync(s.file, "utf8"));
    assert.deepEqual(Object.keys(j.mcpServers).sort(), ["keep", "monomem"]);
    assert.equal(j.mcpServers.monomem.env.MONOMEM_DB_PATH, oldDb);
    assert.match(out.all(), /remove the old "onememory" entry: "claude-bridge" becomes "monomem" and keeps its data/);
  });
  test("with MONOMEM_HOME set the plan names that folder", async () => {
    const { runSetup } = await import("../src/setup.js");
    const custom = join(tmpdir(), "om-r4-custom-home");
    const s = await sandbox({ MONOMEM_HOME: custom });
    writeFileSync(s.file, JSON.stringify({ mcpServers: { onememory: { command: "npx", args: ["-y", "onememory-mcp", "mcp"] } } }, null, 2));
    const out = io();
    await runSetup(s.e, out, { ...s.opts, dryRun: true });
    assert.ok(out.all().includes(custom), out.all());
    assert.doesNotMatch(out.all(), /~\/\.monomem/);
  });
});

describe("7. change feed: CLI honours --limit", () => {
  test("2,000 changes with --limit 10 print 10 entries and the 'more' line", () => {
    const home = tmp("om-r4-feed-");
    const s = new Store(join(home, "state.db"));
    for (let i = 0; i < 2000; i++) s.create({ title: `n${i}`, body: "b" });
    s.close();
    const t0 = Date.now();
    const r = cli(home, ["changes", "--since", "1h", "--limit", "10"]);
    assert.ok(Date.now() - t0 < 15_000);
    const entries = r.stdout.split("\n").filter((l) => /^[+~-] #\d+/.test(l));
    assert.equal(entries.length, 10, r.stdout + r.stderr);
    assert.match(r.stdout, /\.\.\. 1990 more \(use --json or a narrower --since\)/);
  });
  test("cursor pages carry the first page's totals", () => {
    const s = new Store(":memory:");
    try {
      for (let i = 0; i < 30; i++) s.create({ title: `n${i}`, body: "b" });
      const p1 = s.changes({ since: new Date(Date.now() - 3_600_000).toISOString(), limit: 10 });
      const p2 = s.changes({ cursor: p1.nextCursor!, limit: 10 });
      assert.deepEqual(p2.counts, p1.counts);
      assert.equal(p2.counts.total, 30);
    } finally {
      s.close();
    }
  });
});

describe("8. import dedupe without created_at", () => {
  test("importing a file with no created_at twice leaves the count unchanged", async () => {
    setProcessWriter("cli");
    const s = new Store(":memory:");
    try {
      const notes = [{ title: "no date", body: "same body" }];
      await s.importNotes(notes, { dedupe: true });
      await s.importNotes(notes, { dedupe: true });
      assert.equal(s.list({}).total, 1);
    } finally {
      s.close();
    }
  });
});

describe("9. small security hardening", () => {
  test("a namespace that is a known secret is refused before anything is written", () => {
    const dir = tmp("om-r4-ns-");
    const log = join(dir, "audit.log");
    const prev = process.env.MONOMEM_AUDIT_LOG;
    process.env.MONOMEM_AUDIT_LOG = log;
    const s = new Store(":memory:");
    try {
      assert.throws(() => s.create({ title: "t", namespace: "AKIAABCDEFGHIJKLMNOP" }), (e: Error) => e instanceof ValidationError && /looks like a secret/.test(e.message) && !e.message.includes("AKIA"));
      assert.ok(!existsSync(log) || !readFileSync(log, "utf8").includes("AKIA"));
      assert.ok(s.create({ title: "t", namespace: "team-alpha-0f3c9e7d1b2a4c5e" }));
    } finally {
      s.close();
      if (prev === undefined) delete process.env.MONOMEM_AUDIT_LOG;
      else process.env.MONOMEM_AUDIT_LOG = prev;
    }
  });
  test("runner child env drops credential-shaped names and URL passwords, keeps PATH", async () => {
    const { childEnv } = await import("../src/runner.js");
    const env = childEnv({ PATH: "/bin", GH_AUTH: "x", DB_PWD: "x", SENTRY_DSN: "x", AZURE_CONNECTION_STRING: "x", SSH_AUTH_SOCK: "/s", GPG_AGENT_INFO: "x", MONOMEM_HOME: "/h", ONEMEMORY_HOME: "/h", DATABASE_URL: "postgres://u:pw@host/db", PLAIN_URL: "https://example.com" });
    assert.deepEqual(Object.keys(env).sort(), ["PATH", "PLAIN_URL"]);
  });
  test("bad numbers in the rate and tarpit variables fall back to the defaults", async () => {
    const { RateLimiter, AuthTarpit } = await import("../src/security.js");
    const names = ["MONOMEM_RATE_MAX", "MONOMEM_RATE_WINDOW_MS", "MONOMEM_TARPIT_STEP_MS", "MONOMEM_TARPIT_CAP_MS"];
    Object.assign(process.env, { MONOMEM_RATE_MAX: "abc", MONOMEM_RATE_WINDOW_MS: "-5", MONOMEM_TARPIT_STEP_MS: "x", MONOMEM_TARPIT_CAP_MS: "NaN" });
    try {
      const r = new RateLimiter() as unknown as { max: number; windowMs: number };
      assert.deepEqual([r.max, r.windowMs], [120, 10_000]);
      const t = new AuthTarpit() as unknown as { stepMs: number; capMs: number };
      assert.deepEqual([t.stepMs, t.capMs], [250, 2000]);
    } finally {
      for (const k of names) delete process.env[k];
    }
  });
  test("doctor shows a non-loopback bind as [warn]", () => {
    const home = tmp("om-r4-bind-");
    const r = cli(home, ["doctor"], { env: { MONOMEM_BIND: "0.0.0.0" } });
    assert.match(r.stdout, /\[warn\].*MONOMEM_BIND=0\.0\.0\.0 is not a loopback address/);
  });
});

describe("10. docs honesty", () => {
  test("init --print gives VS Code / Copilot its own servers block", () => {
    const r = cli(tmp("om-r4-init-"), ["init", "--print"]);
    assert.match(r.stdout, /Claude Desktop \/ Cursor — add to the MCP config/);
    assert.match(r.stdout, /VS Code \/ Copilot \(\.vscode\/mcp\.json\):\n\{\n {2}"servers": \{\n {4}"monomem": \{\n {6}"type": "stdio"/);
  });
  test("import says pins are not imported", () => {
    const home = tmp("om-r4-pin-");
    const f = join(home, "in.json");
    writeFileSync(f, JSON.stringify({ notes: [{ title: "p", body: "b", pinned: true }, { title: "q", body: "c" }] }));
    const r = cli(home, ["import", "--file", f]);
    assert.match(r.stdout, /1 note\(s\) were pinned in the file; pins are not imported/);
  });
});
