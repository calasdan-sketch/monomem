// Per-app stdio attribution: setup names each app in its MCP entry (MONOMEM_CLIENT), the stdio server stamps
// written_by "stdio:<app>", and filters / the distrust list tell the apps apart while "stdio" still covers them all.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { parseJsonc } from "../src/jsonc-edit.js";
import { DEFAULT_OPTIONS, detectClients, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";
import { actorStore, currentWriter, setProcessWriter, stdioWriter } from "../src/actor.js";
import { Store } from "../src/store.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  setProcessWriter("");
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function sandbox(): { e: SetupEnv; root: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "om-label-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return {
    root,
    db: join(root, "data", "state.db"),
    e: { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-04T12:00:00Z") },
  };
}
const io = (warn: string[] = []): SetupIO => ({ interactive: false, out: (s: string) => void warn.push(s), err: (s: string) => void warn.push(s), ask: async () => "" });
const opts = (s: { db: string }, o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, db: s.db, ...o });

describe("setup names each app (MONOMEM_CLIENT)", () => {
  const expected: Record<string, string> = { "claude-code": "claude-code", "claude-desktop": "claude-desktop", cursor: "cursor", codex: "codex", gemini: "gemini", muse: "muse", vscode: "vscode", zed: "zed", project: "claude-code" };
  for (const [id, label] of Object.entries(expected)) {
    test(`${id}: fresh install writes MONOMEM_CLIENT = ${label}; a second run changes nothing`, async () => {
      const s = sandbox();
      const t = detectClients(s.e).find((x) => x.id === id)!;
      mkdirSync(dirname(t.file), { recursive: true });
      assert.equal(await runSetup(s.e, io(), opts(s, { only: [id as never], project: id === "project" })), 0);
      const text = readFileSync(t.file, "utf8");
      if (id === "codex") assert.match(text, new RegExp(`MONOMEM_CLIENT = "${label}"`));
      else assert.match(JSON.stringify(parseJsonc(text)), new RegExp(`"MONOMEM_CLIENT":"${label}"`));
      assert.equal(await runSetup(s.e, io(), opts(s, { only: [id as never], project: id === "project" })), 0);
      assert.equal(readFileSync(t.file, "utf8"), text, "idempotent");
    });
  }

  test("an entry from before labels gets one on re-run (once), and undo takes it out again", async () => {
    const s = sandbox();
    const file = join(s.e.home, ".cursor", "mcp.json");
    mkdirSync(dirname(file), { recursive: true });
    const old = JSON.stringify({ mcpServers: { monomem: { command: "npx", args: ["-y", "monomem@2.0.0", "mcp"], env: { MONOMEM_DB_PATH: s.db } } } }, null, 2) + "\n";
    writeFileSync(file, old);
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["cursor"] })), 0);
    const j = parseJsonc(readFileSync(file, "utf8")) as { mcpServers: { monomem: { env: Record<string, string>; args: string[] } } };
    assert.deepEqual(j.mcpServers.monomem.env, { MONOMEM_DB_PATH: s.db, MONOMEM_CLIENT: "cursor" });
    assert.deepEqual(j.mcpServers.monomem.args, ["-y", "monomem@2.0.0", "mcp"], "nothing else about the entry changes");
    const once = readFileSync(file, "utf8");
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["cursor"] })), 0);
    assert.equal(readFileSync(file, "utf8"), once);
    assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
    assert.equal(readFileSync(file, "utf8"), old);
  });

  test("an entry with no env gets one; an HTTP entry (url, no command) is left alone", async () => {
    const s = sandbox();
    const gem = join(s.e.home, ".gemini", "settings.json");
    mkdirSync(dirname(gem), { recursive: true });
    writeFileSync(gem, JSON.stringify({ mcpServers: { monomem: { command: "node", args: ["cli.js", "mcp"] } } }));
    const cur = join(s.e.home, ".cursor", "mcp.json");
    mkdirSync(dirname(cur), { recursive: true });
    const http = JSON.stringify({ mcpServers: { monomem: { url: "http://127.0.0.1:8765/mcp" } } });
    writeFileSync(cur, http);
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["gemini", "cursor"] })), 0);
    // Round 2: the data folder set in this shell (MONOMEM_HOME, --db) is pinned into an entry that names none.
    assert.deepEqual((parseJsonc(readFileSync(gem, "utf8")) as { mcpServers: { monomem: { env: unknown } } }).mcpServers.monomem.env, { MONOMEM_CLIENT: "gemini", MONOMEM_HOME: resolve(s.e.env.MONOMEM_HOME!), MONOMEM_DB_PATH: s.db });
    assert.equal(readFileSync(cur, "utf8"), http);
  });

  test("codex: an old [mcp_servers.monomem] table gets an env table once; an inline env is left alone with a hint", async () => {
    const s = sandbox();
    const file = join(s.e.home, ".codex", "config.toml");
    mkdirSync(dirname(file), { recursive: true });
    const old = '[mcp_servers.monomem]\ncommand = "npx"\nargs = ["-y", "monomem@2.0.0", "mcp"]\n';
    writeFileSync(file, old);
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["codex"] })), 0);
    const once = readFileSync(file, "utf8");
    assert.match(once, /\[mcp_servers\.monomem\.env\]\nMONOMEM_CLIENT = "codex"/);
    assert.ok(once.startsWith(old));
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["codex"] })), 0);
    assert.equal(readFileSync(file, "utf8"), once, "idempotent");
    assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
    assert.equal(readFileSync(file, "utf8"), old);

    const inline = '[mcp_servers.monomem]\ncommand = "npx"\nenv = { OTHER = "x" }\n';
    writeFileSync(file, inline);
    const said: string[] = [];
    assert.equal(await runSetup(s.e, io(said), opts(s, { only: ["codex"] })), 0);
    assert.equal(readFileSync(file, "utf8"), inline, "an inline env table cannot get a second env: untouched");
    assert.match(said.join("\n"), /add MONOMEM_CLIENT = "codex"/);
  });
});

describe("the stdio writer marker", () => {
  test("stdioWriter: a valid name becomes stdio:<name> (lower-cased); unset or blank stays plain stdio", () => {
    assert.deepEqual(stdioWriter({}), { writer: "stdio" });
    assert.deepEqual(stdioWriter({ MONOMEM_CLIENT: "  " }), { writer: "stdio" });
    assert.deepEqual(stdioWriter({ MONOMEM_CLIENT: "Cursor" }), { writer: "stdio:cursor" });
    assert.deepEqual(stdioWriter({ MONOMEM_CLIENT: "claude-code" }), { writer: "stdio:claude-code" });
  });

  test("stdioWriter: an invalid name is ignored with a warning, never stored", () => {
    for (const bad of ["a b", "x".repeat(41), "-lead", "a:b", "café", "a\nb", "a/b", "../x"]) {
      const r = stdioWriter({ MONOMEM_CLIENT: bad });
      assert.equal(r.writer, "stdio", bad);
      assert.match(r.warning ?? "", /MONOMEM_CLIENT ignored/);
    }
  });

  test("a token labelled stdio:<app> cannot pose as a local app", () => {
    assert.equal(actorStore.run({ label: "stdio:cursor", authed: true }, () => currentWriter()), "token:stdio:cursor");
    assert.equal(actorStore.run({ label: "STDIO:x", authed: true }, () => currentWriter()), "token:STDIO:x");
  });

  test("the real stdio server stamps stdio:<app> from MONOMEM_CLIENT, and plain stdio without it", async () => {
    const s = sandbox();
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const write = async (env: Record<string, string>): Promise<void> => {
      const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: { PATH: process.env.PATH ?? "", HOME: join(s.root, "home"), USERPROFILE: join(s.root, "home"), MONOMEM_HOME: join(s.root, "om"), MONOMEM_DB_PATH: s.db, ...env }, stderr: "ignore" });
      const c = new Client({ name: "t", version: "1" });
      await c.connect(t);
      try {
        await c.callTool({ name: "state_write", arguments: { title: `from ${env.MONOMEM_CLIENT ?? "none"}` } });
      } finally {
        await c.close();
      }
    };
    await write({ MONOMEM_CLIENT: "cursor" });
    await write({});
    await write({ MONOMEM_CLIENT: "not valid!" });
    const store = new Store(s.db);
    try {
      const by = Object.fromEntries(store.list({ limit: 10 }).notes.map((n) => [n.title, n.written_by]));
      assert.deepEqual(by, { "from cursor": "stdio:cursor", "from none": "stdio", "from not valid!": "stdio" });
    } finally {
      store.close();
    }
  });
});

describe("filters and the distrust list per app", () => {
  function seed(): { s: Store; ids: Record<string, number> } {
    const s = new Store(":memory:");
    const ids: Record<string, number> = {};
    for (const w of ["stdio:cursor", "stdio:claude-code", "stdio", "cli"] as const) {
      setProcessWriter(w);
      ids[w] = s.create({ title: `by ${w}` }).id;
    }
    setProcessWriter("");
    return { s, ids };
  }
  const titles = (notes: Array<{ title: string }>): string[] => notes.map((n) => n.title).sort();

  test("written_by / not_written_by: stdio:<app> is that app only; stdio is every local stdio app", () => {
    const { s } = seed();
    try {
      assert.deepEqual(titles(s.list({ writtenBy: "stdio:cursor" }).notes), ["by stdio:cursor"]);
      assert.deepEqual(titles(s.list({ notWrittenBy: "stdio:cursor" }).notes), ["by cli", "by stdio", "by stdio:claude-code"]);
      assert.deepEqual(titles(s.list({ writtenBy: "stdio" }).notes), ["by stdio", "by stdio:claude-code", "by stdio:cursor"]);
      assert.deepEqual(titles(s.list({ notWrittenBy: "stdio" }).notes), ["by cli"]);
      const feed = (o: { writtenBy?: string; notWrittenBy?: string }): number => (s.changes({ since: "2000-01-01T00:00:00.000Z", ...o }) as unknown as { changes: unknown[] }).changes.length;
      assert.equal(feed({ writtenBy: "stdio:cursor" }), 1);
      assert.equal(feed({ writtenBy: "stdio" }), 3);
      assert.equal(feed({ notWrittenBy: "stdio" }), 1);
    } finally {
      s.close();
    }
  });

  test('distrusting "stdio:cursor" hides Cursor\'s writes but not Claude Code\'s', () => {
    const { s } = seed();
    try {
      s.distrustAdd("default", "stdio:cursor");
      assert.deepEqual(titles(s.list({}).notes), ["by cli", "by stdio", "by stdio:claude-code"]);
      assert.equal(s.distrustMatchCount("default", "stdio:cursor"), 1);
    } finally {
      s.close();
    }
  });

  test('distrusting "stdio" still hides every local stdio app, labelled or not', () => {
    const { s } = seed();
    try {
      s.distrustAdd("*", "stdio");
      assert.deepEqual(titles(s.list({}).notes), ["by cli"]);
      assert.equal(s.isDistrusted({ namespace: "default", written_by: "stdio:anything" }), true);
      assert.equal(s.isDistrusted({ namespace: "default", written_by: "stdiox" }), false);
    } finally {
      s.close();
    }
  });
});
