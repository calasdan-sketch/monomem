// setup on an upgrade from OneMemory, the real layout that went wrong: notes in ~/.onememory/state.db (no ~/.monomem),
// an "onememory" entry that names no database (npx monomem@latest), an older "claude-bridge" entry with its own small
// database, and the old `npx -y onememory-mcp@x hook <event>` hooks. Everything runs in temp dirs.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { buildCaptureCommand, DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";

const CLI = "/opt/monomem/dist/src/cli.js";
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function io(answers: string[] = [], interactive = false): SetupIO & { all: () => string } {
  const l: string[] = [];
  return { interactive, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => answers.shift() ?? "", all: () => l.join("\n") };
}
const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, only: ["claude-code"], hook: "no", capture: "no", ...o });
function notes(db: string, n: number): void {
  const s = new Store(db);
  for (let i = 0; i < n; i++) s.create({ title: `note ${i}`, body: `body ${i} ${db.length}` });
  s.close();
}
const OLD_HOOKS: Record<string, [string, string?]> = {
  SessionStart: ["session-start", "startup|clear"],
  UserPromptSubmit: ["user-prompt"],
  PreToolUse: ["file-context", "Read"],
  PostToolUse: ["post-tool", "*"],
  PostToolUseFailure: ["post-tool-failure", "*"],
  Stop: ["stop"],
  SubagentStop: ["subagent-stop"],
  SessionEnd: ["session-end"],
};
function danLayout(extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "om-legacy-home-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".onememory"));
  const legacyDb = join(home, ".onememory", "state.db");
  notes(legacyDb, 3);
  const bridgeDb = join(root, "my-agent", "claude-bridge", "data", "state.db");
  mkdirSync(join(root, "my-agent", "claude-bridge", "data"), { recursive: true });
  notes(bridgeDb, 2);
  const bridge = { type: "stdio", command: "cmd", args: ["/c", "node", join(root, "my-agent", "claude-bridge", "dist", "src", "mcp-stdio.js")], env: { CLAUDE_BRIDGE_DB_PATH: bridgeDb } };
  const file = join(home, ".claude.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { "claude-bridge": bridge, onememory: { type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "monomem@latest", "mcp"] }, ...extra } }, null, 2));
  const hooks: Record<string, unknown[]> = { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }] };
  for (const [on, [ev, matcher]] of Object.entries(OLD_HOOKS)) (hooks[on] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `npx -y onememory-mcp@2.0.0 hook ${ev}` }] });
  const settings = join(home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks }, null, 2));
  const e: SetupEnv = { home, platform: process.platform, env: { HOME: home }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-09T12:00:00Z") };
  return { root, home, e, file, settings, legacyDb, bridgeDb, bridge };
}

describe("setup: an upgrade whose notes are still in ~/.onememory", () => {
  test("the migrated entry keeps using ~/.onememory (MONOMEM_HOME set), claude-bridge is left as it is with an import hint", async () => {
    const s = danLayout();
    const dry = io();
    assert.equal(await runSetup(s.e, dry, opts({ dryRun: true })), 0, dry.all());
    assert.ok(dry.all().includes(join(s.home, ".onememory")), dry.all());
    assert.doesNotMatch(dry.all(), /"claude-bridge" becomes "monomem"/);
    assert.match(dry.all(), /claude-bridge.*monomem import --file/);

    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true })), 0, out.all());
    const j = JSON.parse(readFileSync(s.file, "utf8"));
    assert.equal(j.mcpServers.onememory, undefined);
    assert.equal(j.mcpServers.monomem.env.MONOMEM_HOME, join(s.home, ".onememory"));
    assert.deepEqual(j.mcpServers["claude-bridge"], s.bridge, "claude-bridge is neither the main store nor dropped");
    assert.equal(Store.peekNoteCount(s.legacyDb), 3, "the notes are still there (the test note was removed again)");
    assert.equal(Store.peekNoteCount(s.bridgeDb), 2);
    assert.ok(!existsSync(join(s.home, ".monomem", "state.db")), "no empty store was started beside the real one");
  });

  test("old onememory-mcp hooks are replaced (not duplicated) by the installed monomem, pointed at the same notes; compact included", async () => {
    const s = danLayout();
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, hook: "yes", capture: "yes" })), 0, out.all());
    const h = JSON.parse(readFileSync(s.settings, "utf8")).hooks;
    const legacyDbFwd = s.legacyDb.replace(/\\/g, "/");
    for (const [on, [ev]] of Object.entries(OLD_HOOKS)) {
      const cmds = (h[on] as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((x) => x.command)).filter((c) => /monomem|onememory/.test(c));
      assert.equal(cmds.length, 1, `${on}: ${JSON.stringify(cmds)}`);
      assert.ok(cmds[0].startsWith(`node "${CLI}" hook ${ev}`), cmds[0]);
      assert.ok(cmds[0].includes(legacyDbFwd), cmds[0]);
    }
    assert.equal(h.SessionStart.find((g: { hooks: Array<{ command: string }> }) => g.hooks[0].command.includes("session-start")).matcher, "startup|clear|compact");
    assert.equal(h.PostToolUse[0].hooks[0].command, "prettier --write", "the person's own hook is untouched");
  });

  test("--yes --hook without --capture still upgrades the old capture hooks (an upgrade, not a new opt-in)", async () => {
    const s = danLayout();
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, hook: "yes", capture: "ask" })), 0, out.all());
    assert.match(out.all(), /upgrade your existing automatic memory hooks/);
    const h = JSON.parse(readFileSync(s.settings, "utf8")).hooks;
    for (const [on, [ev]] of Object.entries(OLD_HOOKS)) {
      const cmds = (h[on] as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((x) => x.command)).filter((c) => /monomem|onememory/.test(c));
      assert.equal(cmds.length, 1, `${on}: ${JSON.stringify(cmds)}`);
      assert.ok(cmds[0].startsWith(`node "${CLI}" hook ${ev}`), cmds[0]);
    }
  });

  test("--no-capture leaves the old capture hooks but warns that they may record nothing", async () => {
    const s = danLayout();
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, hook: "yes", capture: "no" })), 0, out.all());
    assert.match(out.all(), /still run the old onememory-mcp package/);
    assert.match(readFileSync(s.settings, "utf8"), /onememory-mcp@2\.0\.0 hook post-tool/);
  });

  test("ONEMEMORY_DB_PATH in the shell counts as MONOMEM_DB_PATH and reaches the entry", async () => {
    const s = danLayout();
    const e: SetupEnv = { ...s.e, env: { ...s.e.env, ONEMEMORY_DB_PATH: s.legacyDb } };
    const out = io();
    assert.equal(await runSetup(e, out, opts({ yes: true })), 0, out.all());
    assert.equal(JSON.parse(readFileSync(s.file, "utf8")).mcpServers.monomem.env.MONOMEM_DB_PATH, s.legacyDb);
    assert.equal(e.env.MONOMEM_DB_PATH, undefined, "the caller's env is not changed");
  });

  test("a hook command uses the global install for every event when setup runs from npx", () => {
    const e: SetupEnv = { home: "/h", platform: "linux", env: {}, cwd: "/", nodeVersion: "24.4.1", execPath: "/usr/bin/node", cliPath: "/c/_npx/abc/node_modules/monomem/dist/src/cli.js", version: "2.0.0", now: () => new Date(), globalCliPath: "/usr/lib/node_modules/monomem/dist/src/cli.js" };
    for (const ev of ["session-start", "user-prompt", "post-tool", "stop"]) assert.equal(buildCaptureCommand(e, { command: "auto" }, ev), `node "/usr/lib/node_modules/monomem/dist/src/cli.js" hook ${ev}`);
  });
});

describe("setup: a \"monomem\" entry already beside \"onememory\"", () => {
  test("the empty one goes, the one with notes becomes \"monomem\" (shown, asked, never silent)", async () => {
    const empty = join(tmpdir(), "om-legacy-empty-never-created");
    const s = danLayout({ monomem: { command: "npx", args: ["-y", "monomem@2.0.0", "mcp"], env: { MONOMEM_HOME: empty } } });
    const before = readFileSync(s.file, "utf8");
    const plain = io();
    assert.equal(await runSetup(s.e, plain, opts({ yes: true })), 1, "not at a terminal: it stops and says why");
    assert.match(plain.all(), /0 notes[\s\S]*3 notes|3 notes[\s\S]*0 notes/);
    assert.equal(readFileSync(s.file, "utf8"), before);
    const yes = io(["y", "y"], true);
    assert.equal(await runSetup(s.e, yes, opts()), 0, yes.all());
    assert.match(yes.all(), /keep/i);
    const j = JSON.parse(readFileSync(s.file, "utf8"));
    assert.equal(j.mcpServers.onememory, undefined);
    assert.equal(j.mcpServers.monomem.env.MONOMEM_HOME, join(s.home, ".onememory"));
    assert.deepEqual(j.mcpServers["claude-bridge"], s.bridge);
    assert.ok(!existsSync(empty));
  });

  test("both hold notes: it stops, changes nothing and says how to merge", async () => {
    const other = join(mkdtempSync(join(tmpdir(), "om-legacy-other-")), "state.db");
    roots.push(join(other, ".."));
    notes(other, 1);
    const s = danLayout({ monomem: { command: "npx", args: ["-y", "monomem@2.0.0", "mcp"], env: { MONOMEM_DB_PATH: other } } });
    const before = readFileSync(s.file, "utf8");
    const out = io(["y", "y"], true);
    assert.equal(await runSetup(s.e, out, opts()), 1, out.all());
    assert.match(out.all(), /both hold notes/);
    assert.equal(readFileSync(s.file, "utf8"), before);
  });
});
