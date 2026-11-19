// QA round 1: backup default folder, restore wording, MCP argument errors, search words, big and odd text, check --quick.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";
import { describeDbFailure } from "../src/db-problem.js";
import { Store, ValidationError } from "../src/store.js";
import { LIMITS } from "../src/security.js";
import { tooCommonWords } from "../src/keywords.js";
import { runHealth, renderHealth, healthMain, LARGE_STORE_NOTES, type HealthOpts } from "../src/health.js";
import type { DrillReport } from "../src/drill.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const tmp = (): string => mkdtempSync(join(tmpdir(), "monomem-qa1-"));
const run = (args: string[], dataDir: string, input?: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, NO_COLOR: "1", MONOMEM_HOME: dataDir, MONOMEM_DB_PATH: join(dataDir, "state.db"), MONOMEM_AUTO_SCOPE: "" },
  });

describe("backup default folder", () => {
  test("goes inside the data folder's backups folder, not next to it (the temp folder in a test) or in the home folder", () => {
    const dir = tmp();
    assert.equal(run(["add", "something to keep"], dir).status, 0);
    const r = run(["backup"], dir);
    assert.equal(r.status, 0, r.stderr);
    const made = readdirSync(join(dir, "backups")).filter((n) => n.startsWith("monomem-backup-"));
    assert.equal(made.length, 1);
    assert.ok(existsSync(join(dir, "backups", made[0], "state.db")));
    assert.ok(r.stdout.includes(join(dir, "backups", made[0])), r.stdout);
    assert.deepEqual(readdirSync(dirname(dir)).filter((n) => n.startsWith("monomem-backup-")), [], "nothing was written beside the data folder");
    // The automatic daily backups share the folder and are not confused by it: its names are dates only.
    assert.match(run(["backup", "restore"], dir).stderr, /Usage: monomem backup restore/);
  });
  test("an explicit folder still works, as --out and as a plain argument", () => {
    const dir = tmp();
    const out = tmp();
    assert.equal(run(["add", "x"], dir).status, 0);
    assert.equal(run(["backup", "--out", join(out, "one")], dir).status, 0);
    assert.equal(run(["backup", join(out, "two")], dir).status, 0);
    assert.ok(existsSync(join(out, "one", "state.db")));
    assert.ok(existsSync(join(out, "two", "state.db")));
    assert.equal(existsSync(join(dir, "backups")), false);
  });
});

describe("a damaged database says how to put a backup back", () => {
  test("the fix names monomem backup restore", () => {
    const d = describeDbFailure("C:\\x\\state.db", new Error("database disk image is malformed"));
    assert.match(d.fix, /run: monomem backup restore <backup folder>/);
    assert.doesNotMatch(d.fix, /run: monomem restore/);
    assert.match(describeDbFailure("p", new Error("weird failure")).fix, /monomem backup restore <backup folder>/);
  });
});

/** A stdio MCP server in a scratch data folder; send() resolves with the reply to one request. */
async function withServer<T>(fn: (send: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const dir = tmp();
  const p = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db"), MONOMEM_AUTO_SCOPE: "" } });
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  let buf = "";
  p.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        waiting.get(m.id as number)?.(m);
      } catch {
        /* not a reply line */
      }
    }
  });
  let n = 0;
  const send = (msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++n;
      const t = setTimeout(() => reject(new Error("no reply")), 20000);
      waiting.set(id, (m) => (clearTimeout(t), resolve(m)));
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...msg }) + "\n");
    });
  try {
    await send({ method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn(send);
  } finally {
    p.kill();
  }
}
const toolText = (r: Record<string, unknown>): string => ((r.result as { content: Array<{ text: string }> }).content[0].text);

describe("MCP tools/call errors", () => {
  test("missing or invalid params are -32602 with one plain sentence, never a validator dump", async () => {
    await withServer(async (send) => {
      const cases: Array<[Record<string, unknown> | undefined, RegExp]> = [
        [undefined, /^tools\/call needs params with the tool name/],
        [{ name: 5 }, /^tools\/call needs params\.name, the name of the tool, as text; a number was sent\.$/],
        [{}, /params\.name.*it is missing/],
        [{ name: "memory_save", arguments: "nope" }, /^params\.arguments must be an object of named values.*text was sent\.$/],
        [{ name: "memory_save", arguments: [1] }, /a list was sent/],
        [{ name: "memory_save", arguments: null }, /nothing \(null\) was sent/],
      ];
      for (const [params, want] of cases) {
        const r = await send({ method: "tools/call", ...(params ? { params } : {}) });
        const e = r.error as { code: number; message: string };
        assert.equal(e.code, -32602, JSON.stringify(r));
        assert.match(e.message, want);
        assert.doesNotMatch(e.message, /"code"|invalid_type|\[\s*\{|MCP error/);
        assert.ok(!e.message.includes("\n"), "one sentence");
      }
    });
  });
  test("a wrong-typed memory_save argument names the argument, the type it needs and the type it got", async () => {
    await withServer(async (send) => {
      const a = toolText(await send({ method: "tools/call", params: { name: "memory_save", arguments: { title: 5, body: "x" } } }));
      assert.match(a, /memory_save: \\?"title\\?" must be text, but a number was sent\. Nothing was done\./);
      const b = toolText(await send({ method: "tools/call", params: { name: "memory_save", arguments: { title: "t", body: ["a"] } } }));
      assert.match(b, /"body\\?" must be text, but a list was sent/);
      const c = toolText(await send({ method: "tools/call", params: { name: "memory_save", arguments: { title: "t", sensitivity: "secret" } } }));
      assert.match(JSON.parse(c).error, /"sensitivity" must be one of "public", "internal", "private", but "secret" was sent/);
      const d = toolText(await send({ method: "tools/call", params: { name: "memory_search", arguments: {} } }));
      assert.match(d, /"query\\?" is required and must be text/);
      for (const t of [a, b, c, d]) assert.doesNotMatch(t, /invalid_type|Invalid input|✖|MCP error/);
    });
  });
  test("a good call still works, and odd characters are replaced and reported", async () => {
    await withServer(async (send) => {
      const r = toolText(await send({ method: "tools/call", params: { name: "memory_save", arguments: { title: "ok", body: "a\u0000b\ud800c" } } }));
      assert.match(r, /"text_changed":"The text had NUL characters .* and broken characters/);
      const clean = toolText(await send({ method: "tools/call", params: { name: "memory_save", arguments: { title: "ok2", body: "plain" } } }));
      assert.doesNotMatch(clean, /text_changed/);
    });
  });
});

describe("search words", () => {
  test("a word that is filtered as too common still finds a note that has it", () => {
    const dir = tmp();
    assert.equal(run(["add", "hello world", "--title", "hello world"], dir).status, 0);
    const r = run(["search", "hello"], dir);
    assert.match(r.stdout, /Matching notes \(1\)/);
    assert.match(r.stdout, /hello world/);
    assert.doesNotMatch(r.stdout, /no words to search/);
    assert.match(run(["relevant", "hello"], dir).stdout, /hello world/);
  });
  test("when nothing matches, a too-common word is named; a text with no words says so", () => {
    const dir = tmp();
    assert.equal(run(["add", "tea notes"], dir).status, 0);
    assert.match(run(["search", "hello"], dir).stdout, /"hello" is too common to search; try another word\./);
    assert.match(run(["search", "the", "of"], dir).stdout, /"the", "of" are too common to search; try another word\./);
    assert.match(run(["search", "!!!"], dir).stdout, /no words to search for/);
    assert.match(run(["search", "zebra"], dir).stdout, /Searched for: zebra\./);
    assert.deepEqual(tooCommonWords("Hello, the hello Tea"), ["hello", "the"]);
  });
});

describe("big and odd text", () => {
  test("a too-large body says how to split it", () => {
    const s = new Store(":memory:");
    try {
      assert.throws(
        () => s.create({ title: "big", body: "x".repeat(LIMITS.body + 5) }),
        (e: Error) => e instanceof ValidationError && /body exceeds 256000 chars \(this one has 256005\)/.test(e.message) && /Split it/.test(e.message) && /several notes/.test(e.message) && /monomem import --dir <folder>/.test(e.message)
      );
      assert.throws(() => s.create({ title: "t".repeat(LIMITS.title + 1), body: "b" }), /title exceeds 2000 chars \(this one has 2001\)\. Use a short title/);
    } finally {
      s.close();
    }
  });
  test("NUL and lone surrogate characters are replaced, and the writer is told (create and update)", () => {
    const s = new Store(":memory:");
    try {
      const n = s.create({ title: "t\u0000", body: "a\u0000b\ud800c\udc00d \ud83d\ude00 fine" });
      assert.equal(n.title, "t\uFFFD");
      assert.equal(n.body, "a\uFFFDb\uFFFDc\uFFFDd \ud83d\ude00 fine", "a whole emoji is kept");
      assert.match(s.takeCleanedNotice() ?? "", /The text had NUL characters \(invisible zero bytes\) and broken characters .* They were replaced/);
      assert.equal(s.takeCleanedNotice(), null, "taken once");
      s.create({ title: "clean", body: "nothing odd" });
      assert.equal(s.takeCleanedNotice(), null);
      const u = s.update(n.id, { body: "x\u0000y" });
      assert.equal(u?.body, "x\uFFFDy");
      assert.match(s.takeCleanedNotice() ?? "", /The text had NUL characters \(invisible zero bytes\)\. They were replaced/);
    } finally {
      s.close();
    }
  });
  test("monomem add says so when it replaced NUL characters", () => {
    const dir = tmp();
    const r = run(["add", "-"], dir, "line one\u0000line two");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Note: The text had NUL characters/);
  });
});

describe("check --quick", () => {
  const drillOk = async (): Promise<DrillReport> => ({ notes: 0, attacks: 20, rows: [], reached: [], unexpected: [], ok: true, elapsed_ms: 1, approve_first: false });
  function setup(notes: number): { dir: string; opts: HealthOpts; calls: { drill: number } } {
    const dir = tmp();
    const dbPath = join(dir, "state.db");
    const s = new Store(dbPath);
    for (let i = 0; i < notes; i++) s.create({ title: `note ${i}`, body: `body number ${i} about tea`, source: "test" }, { bulkImport: true, skipEdges: true });
    s.close();
    const calls = { drill: 0 };
    const drill = async (): Promise<DrillReport> => (calls.drill++, drillOk());
    return { dir, calls, opts: { dbPath, dataDir: dir, bindHost: "127.0.0.1", settingsPath: join(dir, "settings.json"), pluginsPath: join(dir, "no.json"), auditPath: join(dir, "audit.log"), now: new Date("2026-11-05T12:00:00Z"), drill } };
  }
  test("skips the attack replay and the full note scan, says so, and keeps the other lines", async () => {
    const { dir, opts, calls } = setup(3);
    try {
      const quick = await runHealth({ ...opts, quick: true });
      assert.equal(calls.drill, 0);
      assert.match(quick.checks.find((c) => c.id === "drill")!.text, /skipped \(--quick\)/);
      assert.match(quick.checks.find((c) => c.id === "redacted")!.text, /skipped \(--quick\)/);
      assert.ok(quick.checks.some((c) => c.id === "audit") && quick.checks.some((c) => c.id === "backup") && quick.checks.some((c) => c.id === "memory"));
      assert.equal(quick.hint, undefined);
      // Default semantics are unchanged: the replay runs and the note scan counts.
      const full = await runHealth(opts);
      assert.equal(calls.drill, 1);
      assert.match(full.checks.find((c) => c.id === "drill")!.text, /20 of 20 known attacks/);
      assert.match(full.checks.find((c) => c.id === "redacted")!.text, /\[REDACTED:\.\.\.\] marker.*: 0/);
      assert.equal(full.grade, quick.grade);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a large store gets a line about --quick; --quick and a small store do not", async () => {
    const { dir, opts } = setup(LARGE_STORE_NOTES);
    try {
      const full = await runHealth(opts);
      assert.match(full.hint ?? "", /With 2,000 notes this check takes a few seconds.*monomem check --quick/);
      assert.match(renderHealth(full, false), /monomem check --quick/);
      const quick = await runHealth({ ...opts, quick: true });
      assert.equal(quick.hint, undefined);
      assert.doesNotMatch(renderHealth(quick, false), /check --quick$/m);
      const lines: string[] = [];
      await healthMain(["--quick", "--json"], (l) => lines.push(l), opts);
      assert.match(JSON.parse(lines.join("\n")).checks.find((c: { id: string }) => c.id === "drill").text, /skipped/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("the command takes --quick and the usage lists it", () => {
    const dir = tmp();
    assert.equal(run(["add", "one note"], dir).status, 0);
    const r = run(["check", "--quick", "--verbose"], dir);
    assert.match(r.stdout, /Attack replay: skipped \(--quick\)/);
    assert.match(run(["check", "--help"], dir).stdout, /--quick/);
  });
});
