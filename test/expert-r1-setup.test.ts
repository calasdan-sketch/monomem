import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// Expert round 1: setup passes a non-default MONOMEM_HOME into every app entry, and the Claude Code SessionStart matcher
// is "startup|clear|compact" (an old "startup|clear" entry is upgraded in place, never duplicated).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyOps } from "../src/jsonc-edit.js";
import { CLAUDE_START_MATCHER, DEFAULT_OPTIONS, planHooks, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";
import { PROJECT_ROOT } from "../src/config.js";

const CLI = "/opt/monomem/dist/src/cli.js";
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function sandbox(env: Record<string, string> = {}): { e: SetupEnv; root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "om-r1-setup-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  return { root, home, e: { home, platform: "linux", env: { HOME: home, ...env }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-10-30T12:00:00Z") } };
}
function io(): SetupIO & { all: () => string } {
  const l: string[] = [];
  return { interactive: false, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => "", all: () => l.join("\n") };
}
const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, ...o });

test("a MONOMEM_HOME that is not ~/.monomem is written into the app entry, and setup says so", async () => {
  const s0 = sandbox();
  const custom = join(s0.root, "my-data");
  const s = { ...s0, e: { ...s0.e, env: { ...s0.e.env, MONOMEM_HOME: custom } } };
  mkdirSync(join(s.home, ".cursor"), { recursive: true });
  writeFileSync(join(s.home, ".cursor", "mcp.json"), "{}");
  const out = io();
  assert.equal(await runSetup(s.e, out, opts({ yes: true, only: ["cursor"], db: join(s.root, "d", "state.db") })), 0, out.all());
  const entry = JSON.parse(readFileSync(join(s.home, ".cursor", "mcp.json"), "utf8")).mcpServers.monomem;
  assert.equal(entry.env.MONOMEM_HOME, resolve(custom));
  assert.match(out.all(), /MONOMEM_HOME is set .*each app entry setup writes gets MONOMEM_HOME too/);
});

test("the default home adds no MONOMEM_HOME", async () => {
  const s0 = sandbox();
  const s = { ...s0, e: { ...s0.e, env: { ...s0.e.env, MONOMEM_HOME: join(s0.home, ".monomem") } } };
  mkdirSync(join(s.home, ".cursor"), { recursive: true });
  writeFileSync(join(s.home, ".cursor", "mcp.json"), "{}");
  assert.equal(await runSetup(s.e, io(), opts({ yes: true, only: ["cursor"], db: join(s.root, "d", "state.db") })), 0);
  const entry = JSON.parse(readFileSync(join(s.home, ".cursor", "mcp.json"), "utf8")).mcpServers.monomem;
  assert.equal(entry.env.MONOMEM_HOME, undefined);
});

test("Claude Code's SessionStart matcher includes compact; an old startup|clear entry is upgraded in place, once", () => {
  assert.equal(CLAUDE_START_MATCHER, "startup|clear|compact");
  const s = sandbox();
  const settings = join(s.home, ".claude", "settings.json");
  const fresh = planHooks(s.e, opts({ forceEmpty: true }), undefined, { recall: true, capture: false });
  assert.equal(JSON.parse(applyOps("{}", fresh.change!.ops)).hooks.SessionStart[0].matcher, "startup|clear|compact");
  const old = JSON.stringify({ hooks: { SessionStart: [{ matcher: "resume", hooks: [{ type: "command", command: "echo hi" }] }, { matcher: "startup|clear", hooks: [{ type: "command", command: `node "${CLI}" recall --budget-ms 800` }] }] } }, null, 2);
  writeFileSync(settings, old);
  const r = planHooks(s.e, opts(), undefined, { recall: true, capture: false });
  assert.ok(r.change, "the old matcher is upgraded");
  const after = JSON.parse(applyOps(old, r.change!.ops));
  assert.equal(after.hooks.SessionStart.length, 2, "no duplicate");
  assert.equal(after.hooks.SessionStart[0].matcher, "resume", "someone else's entry is untouched");
  assert.equal(after.hooks.SessionStart[1].matcher, "startup|clear|compact");
  assert.match(after.hooks.SessionStart[1].hooks[0].command, /recall --budget-ms 800/);
  // Undo puts the old one back; running again on the upgraded file changes nothing.
  assert.deepEqual(JSON.parse(applyOps(applyOps(old, r.change!.ops), r.change!.inverse)).hooks.SessionStart.map((x: { matcher: string }) => x.matcher).sort(), ["resume", "startup|clear"]);
  writeFileSync(settings, applyOps(old, r.change!.ops));
  const again = planHooks(s.e, opts(), undefined, { recall: true, capture: false });
  assert.equal(again.change, null);
  assert.equal(again.already, true);
});

test("the plugin's hooks.json uses the same matcher", () => {
  const h = JSON.parse(readFileSync(join(PROJECT_ROOT, "hooks", "hooks.json"), "utf8"));
  assert.equal(h.hooks.SessionStart[0].matcher, CLAUDE_START_MATCHER);
});
