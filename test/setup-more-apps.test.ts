// setup for the apps in src/setup/targets.ts (Windsurf, Devin, Kiro, Cline CLI, Copilot CLI, Antigravity, Qwen Code,
// OpenCode, Kilo Code): documented path, the app's own entry shape, idempotent re-run, foreign content kept, --undo
// restores the exact bytes, and a stale OpenCode entry is rewritten. Everything runs in a temp HOME.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../src/jsonc-edit.js";
import { CLIENT_IDS, DEFAULT_OPTIONS, appEntryProblems, connectedApps, detectClients, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

type Obj = Record<string, unknown>;
type App = { id: string; rel: string; at: string[]; foreign: string; check: (entry: Obj) => void };
const std = (entry: Obj): void => {
  assert.equal(typeof entry.command, "string");
  assert.ok(Array.isArray(entry.args) && (entry.args as string[]).includes("mcp"));
};
const arrayCmd = (entry: Obj): void => {
  assert.equal(entry.type, "local");
  assert.ok(Array.isArray(entry.command) && (entry.command as string[]).at(-1) === "mcp", "command is one array ending in mcp");
  assert.equal((entry.environment as Obj).MONOMEM_CLIENT !== undefined, true);
  assert.equal(entry.args, undefined);
  assert.equal(entry.env, undefined);
};
const APPS: App[] = [
  { id: "windsurf", rel: ".codeium/windsurf/mcp_config.json", at: ["mcpServers"], foreign: '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n', check: std },
  { id: "devin", rel: ".config/devin/mcp_config.json", at: ["mcpServers"], foreign: '{\n  "mcpServers": {\n    "other": { "command": "x", "args": [], "env": {} }\n  }\n}\n', check: std },
  { id: "kiro", rel: ".kiro/settings/mcp.json", at: ["mcpServers"], foreign: '{\n  "mcpServers": {\n    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }\n  }\n}\n', check: std },
  { id: "cline", rel: ".cline/data/settings/cline_mcp_settings.json", at: ["mcpServers"], foreign: '{\n  "mcpServers": {\n    "other": { "command": "node", "args": [], "disabled": false, "autoApprove": [] }\n  }\n}\n', check: std },
  {
    id: "copilot-cli",
    rel: ".copilot/mcp-config.json",
    at: ["mcpServers"],
    foreign: '{\n  "mcpServers": {\n    "playwright": { "type": "local", "command": "npx", "args": ["@playwright/mcp@latest"], "env": {}, "tools": ["*"] }\n  }\n}\n',
    check: (e) => {
      std(e);
      assert.equal(e.type, "local");
      assert.deepEqual(e.tools, ["*"]);
    },
  },
  { id: "antigravity", rel: ".gemini/config/mcp_config.json", at: ["mcpServers"], foreign: '{\n  "mcpServers": {\n    "remote": { "serverUrl": "https://api.example.com/mcp/" }\n  }\n}\n', check: std },
  { id: "qwen", rel: ".qwen/settings.json", at: ["mcpServers"], foreign: '{\n  "theme": "Default",\n  "mcpServers": {\n    "py": { "command": "python", "args": ["-m", "x"] }\n  }\n}\n', check: std },
  {
    id: "opencode",
    rel: ".config/opencode/opencode.json",
    at: ["mcp", "servers"],
    foreign: '{\n  "$schema": "https://opencode.ai/config.json",\n  // mine\n  "mcp": {\n    "servers": {\n      "everything": { "type": "local", "command": ["npx", "-y", "x"], },\n    },\n  },\n}\n',
    check: arrayCmd,
  },
  {
    id: "kilo",
    rel: ".config/kilo/kilo.jsonc",
    at: ["mcp"],
    foreign: '{\n  // kilo\n  "mcp": {\n    "my-local-server": { "type": "local", "command": ["node", "/s.js"], "enabled": true }\n  }\n}\n',
    check: (e) => {
      arrayCmd(e);
      assert.equal(e.enabled, true);
    },
  },
];

function sandbox(): { e: SetupEnv; home: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "om-apps-"));
  roots.push(root);
  const home = join(root, "home");
  for (const a of APPS) mkdirSync(dirname(join(home, a.rel)), { recursive: true });
  return {
    home,
    db: join(root, "data", "state.db"),
    e: { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-17T12:00:00Z") },
  };
}
const io = (): SetupIO => ({ interactive: false, out: () => {}, err: () => {}, ask: async () => "" });
const opts = (s: { db: string }, o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, db: s.db, ...o });
const entryAt = (text: string, at: string[]): Obj | undefined => {
  let v = parseJsonc(text) as Obj | undefined;
  for (const k of at) v = v?.[k] as Obj | undefined;
  return v?.monomem as Obj | undefined;
};

describe("setup: the apps added in 1.6", () => {
  test("every new app is a setup target, found at its documented path", () => {
    const s = sandbox();
    const found = detectClients(s.e);
    for (const a of APPS) {
      assert.ok((CLIENT_IDS as readonly string[]).includes(a.id), a.id);
      const t = found.find((x) => x.id === a.id)!;
      assert.equal(t.file, join(s.home, a.rel), a.id);
      assert.equal(t.present, true, a.id);
    }
    const win = detectClients({ ...s.e, platform: "win32", env: { ...s.e.env, APPDATA: "C:/AD" } });
    assert.equal(win.find((x) => x.id === "devin")!.file, join("C:/AD", "devin", "mcp_config.json"), "Devin on Windows: %APPDATA%\\devin");
    const moved = detectClients({ ...s.e, env: { ...s.e.env, CLINE_MCP_SETTINGS_PATH: "/x/cline.json" } });
    assert.equal(moved.find((x) => x.id === "cline")!.file, "/x/cline.json", "CLINE_MCP_SETTINGS_PATH moves Cline's file");
  });

  test("an app that is not installed is left alone by a plain setup", async () => {
    const s = sandbox();
    rmSync(join(s.home, ".kiro"), { recursive: true });
    assert.equal(await runSetup(s.e, io(), opts(s)), 0);
    assert.equal(existsSync(join(s.home, ".kiro")), false);
    assert.ok(existsSync(join(s.home, ".qwen", "settings.json")), "an installed one is connected");
  });

  for (const a of APPS) {
    test(`${a.id}: fresh install in the app's shape, idempotent, labelled, undo removes the file`, async () => {
      const s = sandbox();
      const file = join(s.home, a.rel);
      assert.equal(await runSetup(s.e, io(), opts(s, { only: [a.id] })), 0);
      const text = readFileSync(file, "utf8");
      const entry = entryAt(text, a.at);
      assert.ok(entry, "monomem entry written");
      a.check(entry!);
      assert.equal(((entry!.env ?? entry!.environment) as Obj).MONOMEM_CLIENT, a.id, "writes are stamped stdio:<app>");
      assert.deepEqual(connectedApps(s.e).connected.includes(detectClients(s.e).find((x) => x.id === a.id)!.label), true);
      assert.equal(await runSetup(s.e, io(), opts(s, { only: [a.id] })), 0);
      assert.equal(readFileSync(file, "utf8"), text, "second run changes nothing");
      assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
      assert.equal(existsSync(file), false);
    });

    test(`${a.id}: keeps foreign content and undo restores the exact bytes`, async () => {
      const s = sandbox();
      const file = join(s.home, a.rel);
      writeFileSync(file, a.foreign);
      assert.equal(await runSetup(s.e, io(), opts(s, { only: [a.id] })), 0);
      const text = readFileSync(file, "utf8");
      assert.ok(entryAt(text, a.at), "entry added next to the existing servers");
      const firstServer = /"([\w-]+)": \{ "(?:type|command|serverUrl)"/.exec(a.foreign)![1];
      assert.ok(text.includes(`"${firstServer}"`), "the other server stays");
      if (a.id === "opencode" || a.id === "kilo") assert.match(text, /\/\/ (mine|kilo)/, "comments kept");
      assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
      assert.equal(readFileSync(file, "utf8"), a.foreign);
    });
  }

  test("opencode: an entry whose program is gone is reported and rewritten in the same shape; undo puts it back", async () => {
    const s = sandbox();
    const file = join(s.home, ".config/opencode/opencode.json");
    const stale = '{\n  "mcp": {\n    "servers": {\n      "monomem": { "type": "local", "command": ["/gone/node", "/gone/dist/src/cli.js", "mcp"], "environment": { "MONOMEM_CLIENT": "opencode" }, "timeout": { "startup": 5000 } }\n    }\n  }\n}\n';
    writeFileSync(file, stale);
    assert.match(appEntryProblems(s.e).join("\n"), /OpenCode: "monomem" points at \/gone\/node/);
    assert.equal(await runSetup(s.e, io(), opts(s, { only: ["opencode"] })), 0);
    const entry = entryAt(readFileSync(file, "utf8"), ["mcp", "servers"])!;
    assert.equal((entry.command as string[])[0], process.execPath);
    assert.deepEqual(entry.environment, { MONOMEM_CLIENT: "opencode" });
    assert.deepEqual(entry.timeout, { startup: 5000 }, "the app's own extra settings stay");
    assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
    assert.equal(readFileSync(file, "utf8"), stale);
  });
});
