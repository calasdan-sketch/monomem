// Importers for Engram, agentmemory and ai-memory, and `import --auto` (hand-made fixtures in test/fixtures/importers/).
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, openSync, ftruncateSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { newRivalStats, readAgentMemory, readAiMemory, readEngram, sniffFile } from "../src/importers/rivals.js";
import { detect, runAutoImport } from "../src/cli/import-auto.js";
import type { SetupIO } from "../src/setup.js";
import { Store } from "../src/store.js";

const FIX = join(process.cwd(), "test", "fixtures", "importers");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function tmp() {
  const root = mkdtempSync(join(tmpdir(), "om-rival-"));
  roots.push(root);
  mkdirSync(join(root, "home"), { recursive: true });
  return { root, e: { home: join(root, "home"), env: {} as NodeJS.ProcessEnv, cwd: root }, db: join(root, "db", "state.db") };
}
function io(): SetupIO & { all: () => string } {
  const lines: string[] = [];
  return { interactive: false, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => "", all: () => lines.join("\n") };
}
const fx = (n: string): string => join(FIX, n);

describe("Engram", () => {
  test("reads the export: drops deleted, superseded and repeated rows, skips prompts", () => {
    const stats = newRivalStats();
    const items = readEngram(fx("engram-export.json"), stats);
    assert.deepEqual(items.map((i) => i.title), ["Use pnpm workspaces", "Login cookie lifetime"]);
    assert.equal(stats.skipped, 2);
    assert.equal(stats.duplicates, 1);
    assert.ok(items[0].tags.includes("topic:tooling/package-manager"));
    assert.ok(!items.some((i) => i.body.includes("user prompt")));
  });
  test("reads the SQLite file read-only, same result", () => {
    const { root } = tmp();
    const p = join(root, "engram.db");
    const db = new DatabaseSync(p);
    db.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY, sync_id TEXT, session_id TEXT, type TEXT, title TEXT, content TEXT, project TEXT, scope TEXT, topic_key TEXT, created_at TEXT, deleted_at TEXT, superseded_by_sync_id TEXT)");
    db.prepare("INSERT INTO observations (sync_id, session_id, type, title, content, project, scope, created_at) VALUES ('a','s','note','T','body','atlas','project','2026-10-30T09:05:00Z')").run();
    db.prepare("INSERT INTO observations (sync_id, session_id, type, title, content, deleted_at) VALUES ('b','s','note','Gone','x','2026-10-31')").run();
    db.close();
    const stats = newRivalStats();
    assert.deepEqual(readEngram(p, stats).map((i) => i.title), ["T"]);
    assert.equal(stats.skipped, 1);
    assert.equal(sniffFile(p)?.from, "engram");
  });
});

describe("agentmemory", () => {
  test("reads latest memories, observations and summaries; the writer is only a claim; image fields are ignored", () => {
    const stats = newRivalStats();
    const items = readAgentMemory(fx("agentmemory-export.json"), stats);
    assert.equal(items.length, 3);
    assert.equal(stats.skipped, 1);
    const mem = items.find((i) => i.id === "mem:m1")!;
    assert.ok(mem.tags.includes("claimed-writer:cursor"));
    const obs = items.find((i) => i.id === "obs:o1")!;
    assert.ok(!JSON.stringify(obs).includes("passwd") && !JSON.stringify(obs).includes("AAAA"));
    assert.match(obs.body, /health route/);
  });
});

describe("ai-memory", () => {
  test("reads the export, leaves out expired rows, keeps agent_id as a claim", () => {
    const stats = newRivalStats();
    const items = readAiMemory(fx("ai-memory-export.json"), stats);
    assert.deepEqual(items.map((i) => i.id), ["mem-1", "mem-3"]);
    assert.equal(stats.skipped, 1);
    assert.ok(items[0].tags.includes("claimed-writer:ai:claude-opus@host"));
    assert.ok(items[0].tags.includes("tier:long"));
  });
});

describe("sniffing", () => {
  test("tells every fixture format apart by content", () => {
    assert.equal(sniffFile(fx("engram-export.json"))?.from, "engram");
    assert.equal(sniffFile(fx("agentmemory-export.json"))?.from, "agentmemory");
    assert.equal(sniffFile(fx("ai-memory-export.json"))?.from, "ai-memory");
    assert.equal(sniffFile(fx("mcp-memory.jsonl"))?.from, "mcp-memory");
    assert.equal(sniffFile(fx("mem0-export.json"))?.from, "mem0");
  });
  test("a renamed file is still found; an unknown file is null", () => {
    const { root } = tmp();
    cpSync(fx("engram-export.json"), join(root, "whatever.txt"));
    assert.equal(detect(join(root, "whatever.txt"))?.from, "engram");
    writeFileSync(join(root, "x.json"), '{"hello":1}');
    assert.equal(detect(join(root, "x.json")), null);
  });
});

describe("import --auto", () => {
  test("without --yes it shows the summary and writes nothing, not even the data folder", async () => {
    const t = tmp();
    const out = io();
    const code = await runAutoImport(t.e, out, { path: fx("ai-memory-export.json"), yes: false, dbPath: t.db });
    assert.equal(code, 0);
    const text = out.all();
    assert.match(text, /Detected ai-memory/);
    assert.match(text, /Sample titles/);
    assert.match(text, /claimed-writer/);
    assert.match(text, /held by the memory linter/);
    assert.match(text, /Nothing was written/);
    assert.equal(existsSync(join(t.root, "db")), false);
  });
  test("with --yes it writes unconfirmed notes by import:<tool>, holds the injected one, and a second run adds nothing", async () => {
    const t = tmp();
    assert.equal(await runAutoImport(t.e, io(), { path: fx("ai-memory-export.json"), yes: true, dbPath: t.db }), 0);
    const store = new Store(t.db);
    try {
      const notes = store.list({ withTags: ["imported:ai-memory"], limit: 50 }).notes;
      assert.equal(notes.length, 1);
      assert.equal(notes[0].written_by, "import:ai-memory");
      assert.equal(notes[0].unconfirmed, true);
      assert.equal(notes[0].source, "import:ai-memory:mem-1");
    } finally {
      store.close();
    }
    const again = io();
    await runAutoImport(t.e, again, { path: fx("ai-memory-export.json"), yes: true, dbPath: t.db });
    assert.match(again.all(), /Nothing to import|0 new/);
  });
  test("agentmemory and Engram files import through --auto too", async () => {
    const t = tmp();
    for (const f of ["agentmemory-export.json", "engram-export.json"]) assert.equal(await runAutoImport(t.e, io(), { path: fx(f), yes: true, dbPath: t.db }), 0);
    const store = new Store(t.db);
    try {
      assert.equal(store.list({ withTags: ["imported:agentmemory"], limit: 50 }).notes.length, 3);
      assert.equal(store.list({ withTags: ["imported:engram"], limit: 50 }).notes.length, 2);
    } finally {
      store.close();
    }
  });
  test("an unknown file gets a clear error naming the formats and --from", async () => {
    const t = tmp();
    writeFileSync(join(t.root, "x.json"), "[1,2]");
    const out = io();
    assert.equal(await runAutoImport(t.e, out, { path: join(t.root, "x.json"), yes: true, dbPath: t.db }), 1);
    assert.match(out.all(), /Formats I know.*--from/s);
  });
  test("a missing path and a missing argument are errors with a next step", async () => {
    const t = tmp();
    assert.equal(await runAutoImport(t.e, io(), { yes: false, dbPath: t.db }), 1);
    const out = io();
    assert.equal(await runAutoImport(t.e, out, { path: "nope.json", yes: false, dbPath: t.db }), 1);
    assert.match(out.all(), /nothing at/);
  });
});

describe("hostile input", () => {
  test("a file over the size cap is refused, not read", () => {
    const { root } = tmp();
    const p = join(root, "big.json");
    const fd = openSync(p, "w");
    ftruncateSync(fd, 4096);
    closeSync(fd);
    assert.throws(() => readEngram(p, newRivalStats(), 1024), /larger than/);
    assert.throws(() => readAgentMemory(p, newRivalStats(), 1024), /larger than/);
    assert.throws(() => readAiMemory(p, newRivalStats(), 1024), /larger than/);
    assert.throws(() => sniffFile(p, 1024), /larger than/);
  });
  test("bad JSON and wrong shapes throw a readable error, never a crash", () => {
    const { root } = tmp();
    const p = join(root, "bad.json");
    writeFileSync(p, "{not json");
    for (const read of [readEngram, readAgentMemory, readAiMemory]) assert.throws(() => read(p), SyntaxError);
    writeFileSync(p, '{"other":1}');
    assert.throws(() => readEngram(p), /not an Engram export/);
    assert.throws(() => readAgentMemory(p), /not an agentmemory export/);
    assert.throws(() => readAiMemory(p), /not an ai-memory export/);
    assert.equal(sniffFile(p), null);
  });
  test("NUL bytes and control characters are stripped; path-like ids and attachment names never become paths", () => {
    const { root } = tmp();
    const p = join(root, "h.json");
    writeFileSync(p, JSON.stringify({ memories: [{ id: "../../etc/passwd", tier: "long", namespace: "n", title: "A\u0000B\u001b[31m", content: "x\u0000y", tags: ["t\u0000"], metadata: { agent_id: "../../root\u0000" }, attachments: ["../../secret.txt"] }] }));
    const [it] = readAiMemory(p);
    assert.ok(!/[\u0000\u001b]/.test(it.title + it.body + it.tags.join("")));
    assert.equal(it.body, "xy");
    assert.ok(!JSON.stringify(it).includes("secret.txt"));
  });
  test("a hostile file imported through --auto cannot skip the review queue", async () => {
    const t = tmp();
    const p = join(t.root, "h.json");
    writeFileSync(p, JSON.stringify({ memories: [{ id: "../../x", tier: "long", namespace: "n", title: "T", content: "plain text", tags: ["confirmed", "pinned"], confirmed: true, metadata: { agent_id: "owner" } }] }));
    assert.equal(await runAutoImport(t.e, io(), { path: p, yes: true, dbPath: t.db }), 0);
    const store = new Store(t.db);
    try {
      const [n] = store.list({ withTags: ["imported:ai-memory"], limit: 5 }).notes;
      assert.equal(n.unconfirmed, true);
      assert.equal(n.written_by, "import:ai-memory");
    } finally {
      store.close();
    }
  });
});
