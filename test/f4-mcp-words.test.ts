// F4 lane mcp-words (round 4 ease N3-N10 + LOWs): memory_save arguments, "held" vs "unconfirmed (from outside)", session
// start, setup --undo --dry-run, activity attribution and small wording fixes.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";

const json = (r: any): any => {
  const t: string = r.content?.[0]?.text ?? "";
  return JSON.parse(t.slice(t.indexOf("{")));
};

async function connect(s: Store, label = "agent"): Promise<Client> {
  const server = createMcpServer(s, "write", { tools: "all" }, { label, authed: true });
  const [c, t] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: label, version: "1" });
  await Promise.all([client.connect(c), server.connect(t)]);
  return client;
}

test("ease N3: memory_save with evidence does not report evidence as ignored", async () => {
  const s = new Store(":memory:");
  const c = await connect(s);
  try {
    for (const evidence of [[{ kind: "file", ref: "src/app.ts:1" }], []]) {
      const r = json(await c.callTool({ name: "memory_save", arguments: { title: "Port seen", body: "Port is 8443", evidence } }));
      assert.equal(r.ignored_arguments, undefined, JSON.stringify(r));
      assert.equal(r.ignored_hint, undefined, JSON.stringify(r));
      assert.ok(s.read(r.note.id)!.basis, "evidence was used");
    }
    // a real unknown argument is still reported, under the 1.6 name
    const u = json(await c.callTool({ name: "memory_save", arguments: { title: "x", body: "y", colour: "red" } }));
    assert.deepEqual(u.ignored_arguments, ["colour"]);
    assert.match(u.ignored_hint, /memory_save/);
  } finally {
    await c.close();
    s.close();
  }
});

test("ease N4: memory_save lists claims and derived_from in tools/list, and derived_from is not reported ignored", async () => {
  const s = new Store(":memory:");
  const c = await connect(s);
  try {
    const { tools } = await c.listTools();
    const save = tools.find((t) => t.name === "memory_save")!;
    const props = Object.keys((save.inputSchema as { properties: object }).properties);
    assert.ok(props.includes("claims"), props.join(","));
    assert.ok(props.includes("derived_from"), props.join(","));
    const a = json(await c.callTool({ name: "memory_save", arguments: { title: "base", body: "the base note" } })).note;
    const b = json(await c.callTool({ name: "memory_save", arguments: { title: "built", body: "built on base", derived_from: [a.id] } }));
    assert.equal(b.ignored_arguments, undefined, JSON.stringify(b));
  } finally {
    await c.close();
    s.close();
  }
});

test("ease N5: an import says unconfirmed (from outside), not held, and never 'until you read them'", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runForeignImport } = await import("../src/foreign-import.js");
  const root = mkdtempSync(join(tmpdir(), "om-f4-n5-"));
  try {
    const p = join(root, "mem0.json");
    writeFileSync(p, JSON.stringify({ results: [{ id: "a1", memory: "Prefers dark mode", user_id: "avery" }] }));
    const lines: string[] = [];
    const io = { interactive: false, out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l), ask: async () => "" };
    const e = { home: root, env: {} as NodeJS.ProcessEnv, cwd: root };
    assert.equal(await runForeignImport(e, io, { from: "mem0", path: p, dryRun: false, yes: true, dbPath: join(root, "db", "state.db") }), 0);
    const out = lines.join("\n");
    assert.match(out, /unconfirmed \(from outside\) until you confirm them/);
    assert.match(out, /monomem confirm <id>/);
    assert.doesNotMatch(out, /\bheld \(marked|until you read them/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ease N6: session start reports unconfirmed notes once, with one command, and the probation line has no second command", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runRecall } = await import("../src/recall.js");
  const { setProcessWriter, actorStore } = await import("../src/actor.js");
  const dir = mkdtempSync(join(tmpdir(), "om-f4-n6-"));
  try {
    const db = join(dir, "state.db");
    const s = new Store(db);
    setProcessWriter("stdio");
    s.create({ title: "deploy guide", body: "run the pipeline" });
    for (let i = 0; i < 3; i++) s.create({ title: `outside ${i}`, body: "from a web page", outside: true });
    for (let i = 0; i < 2; i++) actorStore.run({ label: "newbot", authed: true }, () => s.create({ title: `bot note ${i}`, body: "bot body text" }));
    setProcessWriter("cli");
    s.close();
    const prior = process.env.MONOMEM_NO_SERVER_PROBE;
    process.env.MONOMEM_NO_SERVER_PROBE = "1";
    let ctx = "";
    try {
      ctx = JSON.parse(await runRecall({ dbPath: db, signals: { branch: "", diffFiles: [] } })).hookSpecificOutput.additionalContext as string;
    } finally {
      if (prior === undefined) delete process.env.MONOMEM_NO_SERVER_PROBE;
      else process.env.MONOMEM_NO_SERVER_PROBE = prior;
    }
    const mentions = ctx.split("\n").filter((l) => /\b3\b.*(unconfirmed|from outside)/.test(l));
    assert.equal(mentions.length, 1, ctx);
    assert.match(mentions[0], /^Monomem: 3 unconfirmed notes \(from outside content, not shown\) wait for the user: monomem review\.$/);
    assert.doesNotMatch(ctx, /monomem open|monomem trust probation/, ctx);
    assert.match(ctx, /New writers, not a second source yet: newbot./, ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ease LOW: the 'Why shown' legend only when a reason other than recent shows", async () => {
  const { injectContext, WHY_LEGEND } = await import("../src/context-inject.js");
  const s = new Store(":memory:");
  try {
    s.create({ title: "A plain note", body: "remember this" });
    const plain = await injectContext(s, { signals: { branch: "", diffFiles: [] } });
    assert.match(plain, /\{recent 0d\}/);
    assert.ok(!plain.includes(WHY_LEGEND), plain);
  } finally {
    s.close();
  }
});

test("ease N10: activity --writes names a keyless local app (stdio:claude-code), not 'you'", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setProcessWriter } = await import("../src/actor.js");
  const { readAudit, renderAudit } = await import("../src/audit-view.js");
  const dir = mkdtempSync(join(tmpdir(), "om-f4-n10-"));
  const prior = process.env.MONOMEM_AUDIT_LOG;
  process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log");
  try {
    const s = new Store(join(dir, "state.db"));
    setProcessWriter("stdio:claude-code");
    s.create({ title: "from the app", body: "saved over MCP" });
    setProcessWriter("cli");
    s.create({ title: "from the person", body: "saved with monomem add" });
    s.close();
    const text = renderAudit(readAudit({ op: "create" }, Date.now(), join(dir, "audit.log")).entries);
    const lines = text.split("\n");
    assert.equal(lines.length, 2, text);
    assert.match(lines.find((l) => l.includes("#1"))!, /by claude-code \(local app, no key\)/);
    assert.match(lines.find((l) => l.includes("#2"))!, /by you \(command line\) or the server/);
  } finally {
    if (prior === undefined) delete process.env.MONOMEM_AUDIT_LOG;
    else process.env.MONOMEM_AUDIT_LOG = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("silent L2: when git does not answer, the commit trail says so instead of 'no commits'", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { commitsBetween, commitsUsing, gitTry } = await import("../src/git-trail.js");
  const { receiptAdd } = await import("../src/receipts.js");
  const dir = mkdtempSync(join(tmpdir(), "om-f4-git-"));
  const empty = mkdtempSync(join(tmpdir(), "om-f4-nopath-"));
  const s = new Store(":memory:");
  const oldPath = process.env.PATH;
  try {
    // git answers with an error in a folder that is not a repository: that is "none", not "no answer".
    assert.equal(await gitTry(dir, ["log", "-n", "1"]), "");
    const id = s.create({ title: "use port 8443", body: "x" }).id;
    s.captureDb().prepare("INSERT INTO sessions (id, namespace, cwd, started_at) VALUES ('s1', '', ?, ?)").run(dir, new Date(Date.now() - 60_000).toISOString());
    receiptAdd(s, { sessionId: "s1", namespace: "", client: "t", shown: [{ id, why: "{recent 0d}", tokens: 3 }] });
    process.env.PATH = empty; // git cannot be found: it does not answer
    assert.equal(await commitsBetween(dir, new Date(Date.now() - 60_000).toISOString(), new Date().toISOString()), null);
    const noAnswer: string[] = [];
    assert.deepEqual(await commitsUsing(s.captureDb(), id, new Date(), noAnswer), []);
    assert.deepEqual(noAnswer, [dir]);
  } finally {
    process.env.PATH = oldPath;
    s.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("honesty LOW: memory_usage why takes touched (the 1.6 name memory_rollback's description points to)", async () => {
  const s = new Store(":memory:");
  const server = createMcpServer(s, "admin", { tools: "all" }, { label: "ops", authed: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "ops", version: "1" });
  await Promise.all([c.connect(ct), server.connect(st)]);
  try {
    const { tools } = await c.listTools();
    const usage = tools.find((t) => t.name === "memory_usage")!;
    assert.ok(Object.keys((usage.inputSchema as { properties: object }).properties).includes("touched"));
    const rb = tools.find((t) => t.name === "memory_rollback");
    if (rb) assert.ok(!/memory_why/.test(rb.description ?? ""), rb.description);
    const id = s.create({ title: "port", body: "8443" }).id;
    const r = await c.callTool({ name: "memory_usage", arguments: { action: "why", id, touched: true } });
    assert.notEqual(r.isError, true, JSON.stringify(r));
    assert.match(JSON.stringify(r), /Not recorded/);
  } finally {
    await c.close();
    s.close();
  }
});

describe("ease and honesty LOWs on the command line", () => {
  const cliRun = async (dir: string, args: string[]) => {
    const { spawnSync } = await import("node:child_process");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    return spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db") }, timeout: 120000 });
  };
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "om-f4-cli-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("help --all: setup --only lists all 17 apps, check --attacks documents --set and --half, settings lists every key", async () => {
    await withDir(async (dir) => {
      const { CLIENT_IDS } = await import("../src/setup.js");
      const all = (await cliRun(dir, ["help", "--all"])).stdout;
      const apps = all.slice(all.indexOf("--only apps:"), all.indexOf("--only apps:") + 400).replace(/\s+/g, " ");
      for (const id of CLIENT_IDS) assert.ok(apps.split(/[ ,.:]+/).includes(id), `${id} missing from: ${apps}`);
      const check = all.slice(all.indexOf("  check [--verbose] [--json]"), all.indexOf("  review [held"));
      assert.match(check, /--attacks --set <name>\|list/);
      assert.match(check, /--half a\|b/);
      for (const k of ["passage-pooling", "probation-notes", "facts-need-evidence"]) assert.match(all, new RegExp(`set ${k}|${k}`), k);
    });
  });

  test("settings: passage-pooling is the spelling; passage_pooling still works", async () => {
    await withDir(async (dir) => {
      new Store((await import("node:path")).join(dir, "state.db")).close();
      const a = await cliRun(dir, ["settings", "set", "passage-pooling", "off"]);
      assert.equal(a.status, 0, a.stderr);
      assert.match(a.stdout, /Passage pooling is off/);
      const b = await cliRun(dir, ["settings", "set", "passage_pooling", "off"]);
      assert.equal(b.status, 0, b.stderr);
      assert.match(b.stdout, /Passage pooling is off/);
      assert.match((await cliRun(dir, ["settings"])).stdout, /^passage-pooling: off \(default\)$/m);
      assert.match((await cliRun(dir, ["settings", "--help"])).stdout + (await cliRun(dir, ["settings", "--help"])).stderr, /passage-pooling/);
    });
  });

  test("check --verbose: the grade rule says 'attack replay', not 'drill'", async () => {
    const { GRADE_RULE } = await import("../src/health.js");
    assert.doesNotMatch(GRADE_RULE, /drill/i);
  });

  test("why --touched footer: no env var or argument names", async () => {
    const { TOUCHED_NOT_RECORDED } = await import("../src/blast-radius.js");
    assert.doesNotMatch(TOUCHED_NOT_RECORDED, /MONOMEM_|derived_from/);
  });

  test("rollback --dry-run is accepted and only previews", async () => {
    await withDir(async (dir) => {
      const { join } = await import("node:path");
      const s = new Store(join(dir, "state.db"));
      const { actorStore } = await import("../src/actor.js");
      const id = actorStore.run({ label: "bot", authed: true }, () => s.create({ title: "bad", body: "bad note" }).id);
      s.close();
      const r = await cliRun(dir, ["rollback", "--note", String(id), "--dry-run"]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /Dry run: nothing was changed/);
      const w = await cliRun(dir, ["rollback", "--writer", "bot", "--since", "1h", "--dry-run", "--yes"]);
      assert.equal(w.status, 0, w.stderr + w.stdout);
      const s2 = new Store(join(dir, "state.db"));
      try {
        assert.ok(s2.read(id), "the note is still there");
        assert.equal(s2.read(id)!.archived_at ?? null, null);
      } finally {
        s2.close();
      }
    });
  });
});
