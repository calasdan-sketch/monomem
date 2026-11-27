// `monomem setup --verify`: the real command line from each app's own config is started, round-tripped on a throwaway store.
// Everything lives in temp folders: a fake HOME holds the app configs; the "real" data folder named in an entry's env must stay empty.
import "./setup-env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { realEnv, type SetupEnv, type SetupIO } from "../src/setup.js";
import { monomemEntries, probeEnv, runVerify, verifyClients } from "../src/setup/verify.js";

const CLI = join(import.meta.dirname, "..", "src", "cli.js");
let home = "";
let realData = "";
let env: SetupEnv;
const lines: string[] = [];
const io: SetupIO = { out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => "", interactive: false };

before(() => {
  home = mkdtempSync(join(tmpdir(), "verify-home-"));
  realData = mkdtempSync(join(tmpdir(), "verify-realdata-"));
  env = { ...realEnv("0.0.0-test", CLI), home, env: {}, cwd: home };
  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(home, ".gemini"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  const good = { command: process.execPath, args: [CLI, "mcp"], env: { MONOMEM_CLIENT: "cursor", MONOMEM_HOME: realData, MONOMEM_DB_PATH: join(realData, "state.db"), MONOMEM_AUDIT_LOG: join(realData, "audit.log") } };
  writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" }, monomem: good } }));
  writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { monomem: { command: join(home, "no-such-node.exe"), args: ["monomem", "mcp"] } } }));
  const toml = `[mcp_servers.monomem]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify("-e")}, ${JSON.stringify("process.exit(3)")}]\n`;
  writeFileSync(join(home, ".codex", "config.toml"), toml);
});
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(realData, { recursive: true, force: true });
});

describe("setup --verify", () => {
  test("probeEnv drops every real data location and pins a temp one", () => {
    const e = probeEnv({ MONOMEM_HOME: "/real", ONEMEMORY_HOME: "/real2", MONOMEM_DB_PATH: "/real/s.db", MONOMEM_KEY_FILE: "/k", MONOMEM_CLIENT: "cursor", MONOMEM_TOOLS: "all", OTHER: "1" }, "/tmp/x");
    assert.equal(e.MONOMEM_HOME, "/tmp/x");
    assert.equal(e.ONEMEMORY_HOME, "/tmp/x");
    assert.ok(e.MONOMEM_DB_PATH.startsWith("/tmp/x") || e.MONOMEM_DB_PATH.includes("x"));
    assert.equal(e.MONOMEM_KEY_FILE, undefined);
    assert.equal(e.MONOMEM_CLIENT, "cursor");
    assert.equal(e.MONOMEM_TOOLS, "all");
    assert.equal(e.OTHER, "1");
  });

  test("monomemEntries reads JSON and TOML configs and ignores other servers", () => {
    assert.equal(monomemEntries(JSON.stringify({ mcpServers: { a: { command: "x" }, monomem: { command: "n", args: ["mcp"] } } }), "cursor").length, 1);
    assert.equal(monomemEntries(`[mcp_servers.monomem]\ncommand = "n"\nargs = ["mcp"]\n`, "codex")[0].command, "n");
  });

  test("a good entry round-trips PASS; a missing program and a server that dies FAIL with the file named; the real data folder is untouched", async () => {
    const res = await verifyClients(env, undefined, 20_000);
    const by = Object.fromEntries(res.map((r) => [r.client, r]));
    assert.equal(by.cursor.status, "PASS", JSON.stringify(by.cursor));
    assert.equal(by.cursor.file, join(home, ".cursor", "mcp.json"));
    assert.equal(by.gemini.status, "FAIL");
    assert.match(by.gemini.detail, /does not exist/);
    assert.ok(by.gemini.hint.includes(join(home, ".gemini", "settings.json")));
    assert.equal(by.codex.status, "FAIL");
    assert.deepEqual(readdirSync(realData), [], "the entry's own data folder was never opened");
  });

  test("runVerify prints PASS/FAIL per app with path and fix, says it used a throwaway store, exit 1 when any failed", async () => {
    lines.length = 0;
    const code = await runVerify(env, io, undefined, 20_000);
    const text = lines.join("\n");
    assert.equal(code, 1);
    assert.match(text, /PASS\s+Cursor\s+.*mcp\.json/);
    assert.match(text, /FAIL\s+Gemini CLI/);
    assert.match(text, /Fix: /);
    assert.match(text, /throwaway store/);
  });

  test("nothing configured: says run setup, exit 1", async () => {
    const empty = mkdtempSync(join(tmpdir(), "verify-empty-"));
    try {
      lines.length = 0;
      assert.equal(await runVerify({ ...env, home: empty, cwd: empty }, io), 1);
      assert.match(lines.join("\n"), /monomem setup/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("the CLI: setup --verify-only with a fake home prints the table and exits 1 on a failure", () => {
    const e = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), MONOMEM_HOME: join(home, "data"), ONEMEMORY_HOME: join(home, "data"), MONOMEM_AUDIT_LOG: join(home, "audit.log") };
    const r = spawnSync(process.execPath, [CLI, "setup", "--verify-only", "--only", "cursor,gemini"], { cwd: home, env: e, encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS\s+Cursor/);
    assert.match(r.stdout, /FAIL\s+Gemini CLI/);
  });
});
