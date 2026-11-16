// Monomem was called claude-bridge: its CLAUDE_BRIDGE_* settings must keep working, and keep the data.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLegacyEnv } from "../src/legacy-env.js";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { downgradeTo } from "./legacy-db.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "om-legacy-env-"));
  roots.push(d);
  return d;
};

describe("legacy environment names", () => {
  test("CLAUDE_BRIDGE_X is read as MONOMEM_X", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_BRIDGE_DB_PATH: "C:\\Users\\testuser\\data\\state.db", CLAUDE_BRIDGE_PORT: "9000" };
    assert.deepEqual(applyLegacyEnv(env).sort(), ["CLAUDE_BRIDGE_DB_PATH", "CLAUDE_BRIDGE_PORT"]);
    assert.equal(env.MONOMEM_DB_PATH, "C:\\Users\\testuser\\data\\state.db");
    assert.equal(env.MONOMEM_PORT, "9000");
  });
  test("the new name always wins when both are set", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_BRIDGE_DB_PATH: "old", MONOMEM_DB_PATH: "new" };
    assert.deepEqual(applyLegacyEnv(env), []);
    assert.equal(env.MONOMEM_DB_PATH, "new");
  });
  test("an empty old value or a bare prefix is ignored", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_BRIDGE_DB_PATH: "", CLAUDE_BRIDGE_: "x" };
    assert.deepEqual(applyLegacyEnv(env), []);
    assert.equal(env.MONOMEM_DB_PATH, undefined);
  });
  test("an empty new value is filled from the old one", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_BRIDGE_DB_PATH: "old", MONOMEM_DB_PATH: "" };
    applyLegacyEnv(env);
    assert.equal(env.MONOMEM_DB_PATH, "old");
  });
  test("other variables are never touched", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/x" };
    applyLegacyEnv(env);
    assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CONFIG_DIR", "PATH"]);
  });
});

describe("the real programs honour CLAUDE_BRIDGE_DB_PATH", () => {
  function oldDb(): { dir: string; db: string } {
    const dir = tmp();
    const db = join(dir, "claude bridge", "data", "state.db");
    mkdirSync(dirname(db), { recursive: true });
    const st = new Store(db);
    st.create({ title: "Old memory one", body: "from the claude-bridge days" });
    st.create({ title: "Old memory two", body: "also old" });
    st.close();
    downgradeTo(db, 13);
    return { dir, db };
  }
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: env.HOME, USERPROFILE: env.HOME, ...env } });

  test("doctor finds the OLD database and only reports it; the next command upgrades it and saves the verified pre-upgrade copy beside it", () => {
    const { dir, db } = oldDb();
    const r = run(["doctor"], { HOME: join(dir, "home"), CLAUDE_BRIDGE_DB_PATH: db });
    const out = r.stdout + r.stderr;
    assert.ok(out.includes(db), "it is the old path, not ~/.monomem");
    assert.match(out, /CLAUDE_BRIDGE_DB_PATH/, "and it says the old name was read");
    // 1.5.0: doctor only looks (apps that still have the file open would keep writing in the old shape).
    assert.match(out, /schema v13.*doctor did not upgrade it/);
    assert.equal(Store.peekSchemaVersion(db), 13);
    assert.equal(run(["ls"], { HOME: join(dir, "home"), CLAUDE_BRIDGE_DB_PATH: db }).status, 0);
    assert.match(run(["doctor"], { HOME: join(dir, "home"), CLAUDE_BRIDGE_DB_PATH: db }).stdout, /database OK at .*state\.db \(2 notes\)/);
    const copy = db + `.pre-v${SCHEMA_VERSION}-backup`;
    assert.ok(existsSync(copy), "pre-upgrade copy exists");
    assert.equal(Store.peekSchemaVersion(copy), 13, "the copy is still in the old format");
    assert.equal(Store.peekSchemaVersion(db), SCHEMA_VERSION);
    assert.equal(existsSync(join(dir, "home", ".monomem", "state.db")), false, "no empty store was started elsewhere");
  });

  test("the stdio server answers over MCP from the old database", async () => {
    const { dir, db } = oldDb();
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const t = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: { PATH: process.env.PATH ?? "", HOME: join(dir, "home"), USERPROFILE: join(dir, "home"), CLAUDE_BRIDGE_DB_PATH: db }, stderr: "ignore" });
    const c = new Client({ name: "t", version: "1" });
    await c.connect(t);
    try {
      const res = (await c.callTool({ name: "state_search", arguments: { query: "claude-bridge days" } })) as { content: Array<{ text: string }> };
      assert.match(res.content[0].text, /Old memory one/);
    } finally {
      await c.close();
    }
  });

  test("the new name wins when a config sets both", () => {
    const { dir, db } = oldDb();
    const other = join(dir, "other.db");
    new Store(other).close();
    const r = run(["doctor"], { HOME: join(dir, "home"), CLAUDE_BRIDGE_DB_PATH: db, MONOMEM_DB_PATH: other });
    assert.ok((r.stdout + r.stderr).includes(other));
    assert.equal(existsSync(db + `.pre-v${SCHEMA_VERSION}-backup`), false, "the old database was not opened");
  });

  test("doctor names the old program each mapped setting came from", () => {
    const { dir } = oldDb();
    mkdirSync(join(dir, "om"), { recursive: true }); // a set-up data folder: doctor on a missing one only says "not set up"
    const r = run(["doctor"], { HOME: join(dir, "home"), ONEMEMORY_HOME: join(dir, "om"), CLAUDE_BRIDGE_PORT: "18999" });
    const out = r.stdout + r.stderr;
    assert.match(out, /ONEMEMORY_HOME \(from OneMemory\)/);
    assert.match(out, /CLAUDE_BRIDGE_PORT \(from claude-bridge\)/);
    assert.doesNotMatch(out, /ONEMEMORY_HOME \(from claude-bridge\)/);
  });

  test("the recall hook with --db reads that database and does not upgrade an older one", () => {
    const { dir, db } = oldDb();
    const r = run(["recall", "--db", db], { HOME: join(dir, "home") });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /SessionStart/);
    assert.equal(Store.peekSchemaVersion(db), 13, "the hook never upgrades a database");
  });
});
