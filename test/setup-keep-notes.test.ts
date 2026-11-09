// setup must never delete a note it did not write in the same run, must find the Microsoft Store (MSIX) Claude Desktop
// config, must turn Codex's old [mcp_servers.onememory] into [mcp_servers.monomem] (not add a second server), and must
// tell a person with two full stores to import the SMALLER one into the LARGER one. Everything runs in temp dirs.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { DEFAULT_OPTIONS, detectClients, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";

const CLI = "/opt/monomem/dist/src/cli.js";
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function io(answers: string[] = [], interactive = false): SetupIO & { all: () => string } {
  const l: string[] = [];
  return { interactive, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => answers.shift() ?? "", all: () => l.join("\n") };
}
const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, hook: "no", capture: "no", ...o });
function notes(db: string, n: number): void {
  const s = new Store(db);
  for (let i = 0; i < n; i++) s.create({ title: `note ${i}`, body: `body ${i}` });
  s.close();
}
function sandbox(platform: NodeJS.Platform = process.platform) {
  const root = mkdtempSync(join(tmpdir(), "om-keep-notes-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const env = { HOME: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") };
  const e: SetupEnv = { home, platform, env, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-09T12:00:00Z") };
  return { root, home, e };
}

describe("setup never deletes a note it did not write in this run", () => {
  test("a pinned 'OneMemory is connected' note from an old installer survives untouched, with a one-line hint", async () => {
    const s = sandbox();
    const db = join(s.root, "state.db");
    const st = new Store(db);
    const old = st.create({ title: "OneMemory is connected", body: "This note was written by `onememory setup`.", tags: ["setup-check"], source: "onememory setup" });
    st.setPinned(old.id, true);
    st.create({ title: "real note", body: "keep me" });
    const before = JSON.stringify(st.read(old.id)); // gate-ok: test reads its own fixture
    st.close();
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, db, only: ["claude-code"] })), 0, out.all());
    const after = new Store(db);
    try {
      assert.equal(after.list({}).total, 2, "note count unchanged");
      assert.equal(JSON.stringify(after.read(old.id)), before, "the old note is exactly as it was (not deleted, archived or unpinned)"); // gate-ok
      assert.equal(after.read(old.id)?.pinned, true); // gate-ok
    } finally {
      after.close();
    }
    assert.doesNotMatch(out.all(), /removed \d+ leftover/);
    assert.match(out.all(), new RegExp(`#${old.id}.*OneMemory is connected`));
  });
});

describe("Claude Desktop from the Microsoft Store (MSIX)", () => {
  test("its config under LOCALAPPDATA/Packages/Claude_*/LocalCache/Roaming/Claude is found and its monomem entry handled; undo restores", async () => {
    const s = sandbox("win32");
    const dir = join(s.home, "AppData", "Local", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude_desktop_config.json");
    const orig = JSON.stringify({ mcpServers: { monomem: { command: "cmd", args: ["/c", "npx", "-y", "monomem@latest", "mcp"] } } }, null, 2);
    writeFileSync(file, orig);
    const found = detectClients(s.e).filter((c) => c.id === "claude-desktop");
    assert.ok(found.some((c) => c.file === file && c.exists), JSON.stringify(found));
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, db: join(s.root, "state.db"), only: ["claude-desktop"] })), 0, out.all());
    const j = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(j.mcpServers), ["monomem"], "no second server");
    assert.equal(j.mcpServers.monomem.env.MONOMEM_CLIENT, "claude-desktop");
    assert.equal(await runSetup(s.e, io(), opts({ undo: true })), 0);
    assert.equal(readFileSync(file, "utf8"), orig);
  });
});

describe("Codex: an old [mcp_servers.onememory] becomes [mcp_servers.monomem]", () => {
  test("replaced, not added beside; same data; undo restores the exact bytes", async () => {
    const s = sandbox();
    mkdirSync(join(s.home, ".codex"));
    const file = join(s.home, ".codex", "config.toml");
    const orig = 'model = "o5"\n\n[mcp_servers.onememory]\ncommand = "npx"\nargs = ["-y", "onememory-mcp@2.0.0"]\n\n[mcp_servers.onememory.env]\nONEMEMORY_HOME = "/data/om"\n\n[projects."/w"]\ntrust_level = "trusted"\n';
    writeFileSync(file, orig);
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, only: ["codex"] })), 0, out.all());
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /onememory/, text);
    assert.equal(text.match(/\[mcp_servers\.monomem\]/g)?.length, 1, text);
    assert.match(text, /MONOMEM_HOME = "\/data\/om"/, "same data folder");
    assert.match(text, /MONOMEM_CLIENT = "codex"/);
    assert.match(text, /^model = "o5"/);
    assert.match(text, /\[projects\."\/w"\]\ntrust_level = "trusted"/);
    assert.equal(await runSetup(s.e, io(), opts({ undo: true })), 0);
    assert.equal(readFileSync(file, "utf8"), orig);
  });
});

describe("two stores that both hold notes", () => {
  test("the hint keeps the LARGER store and imports the SMALLER one into it, naming both with counts", async () => {
    const s = sandbox();
    const big = join(s.root, "big.db");
    const small = join(s.root, "small.db");
    notes(big, 3);
    notes(small, 1);
    const file = join(s.home, ".claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { monomem: { command: "npx", args: ["-y", "monomem@2.0.0", "mcp"], env: { MONOMEM_DB_PATH: small } }, onememory: { command: "npx", args: ["-y", "monomem@latest", "mcp"], env: { ONEMEMORY_DB_PATH: big } } } }, null, 2));
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, only: ["claude-code"] })), 1, out.all());
    const t = out.all();
    assert.match(t, /larger/i, t);
    const keep = t.indexOf("main data");
    assert.ok(keep >= 0, t);
    assert.ok(t.includes(`${big}`) && t.includes("3 notes") && t.includes("1 notes"), t);
    assert.match(t, new RegExp(`import --file other\\.json  with MONOMEM_DB_PATH=${big.replace(/[\\.]/g, "\\$&")}`), t);
    assert.match(t, new RegExp(`Copy ${small.replace(/[\\.]/g, "\\$&")} first`), t);
    assert.match(t, /delete the "monomem" entry/, "the entry for the smaller store is the one to drop");
  });
});

describe("claude-bridge beside the main entry, with a database pinned in the shell", () => {
  test("the import hint names claude-bridge's OWN database and its count, not the pinned one", async () => {
    const s = sandbox();
    const main = join(s.root, "main.db");
    const bridgeDb = join(s.root, "bridge", "state.db");
    mkdirSync(join(s.root, "bridge"));
    notes(main, 3);
    notes(bridgeDb, 2);
    const bridge = { command: "node", args: [join(s.root, "bridge", "dist", "src", "mcp-stdio.js")], env: { CLAUDE_BRIDGE_DB_PATH: bridgeDb } };
    const file = join(s.home, ".claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { onememory: { command: "npx", args: ["-y", "monomem@latest", "mcp"] }, "claude-bridge": bridge } }, null, 2));
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, db: main, only: ["claude-code"] })), 0, out.all());
    assert.ok(out.all().includes(`has its own database (${bridgeDb}, 2 notes)`), out.all());
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).mcpServers["claude-bridge"], bridge);
  });
});
