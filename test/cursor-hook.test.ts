// Cursor's sessionStart hook: setup writes ~/.cursor/hooks.json in Cursor's shape (version 1, {command}), keeps other
// hooks, undo restores the exact bytes; `hook cursor-session-start` answers {"additional_context"} with the same notes
// session-start shows, reading the folder from workspace_roots.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";
import { Store } from "../src/store.js";
import { runHook } from "../src/hook.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function sandbox(): { e: SetupEnv; home: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "om-cursor-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  return {
    home,
    db: join(root, "data", "state.db"),
    e: { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-17T12:00:00Z") },
  };
}
const io = (): SetupIO => ({ interactive: false, out: () => {}, err: () => {}, ask: async () => "" });
const opts = (s: { db: string }, o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, db: s.db, only: ["cursor"], hook: "yes", capture: "no", ...o });

describe("Cursor session-start hook", () => {
  test("setup adds it in Cursor's shape, once; undo removes the file it created", async () => {
    const s = sandbox();
    const file = join(s.home, ".cursor", "hooks.json");
    assert.equal(await runSetup(s.e, io(), opts(s)), 0);
    const v = JSON.parse(readFileSync(file, "utf8")) as { version: number; hooks: { sessionStart: Array<Record<string, unknown>> } };
    assert.equal(v.version, 1);
    assert.equal(v.hooks.sessionStart.length, 1);
    assert.deepEqual(Object.keys(v.hooks.sessionStart[0]), ["command"]);
    assert.match(String(v.hooks.sessionStart[0].command), /hook cursor-session-start/);
    const text = readFileSync(file, "utf8");
    assert.equal(await runSetup(s.e, io(), opts(s, { capture: "yes" })), 0);
    assert.equal(readFileSync(file, "utf8"), text, "second run (with capture too) changes nothing");
    assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
    assert.equal(existsSync(file), false);
  });

  test("--no-hook leaves hooks.json alone; existing hooks are kept and undo restores the exact bytes", async () => {
    const s = sandbox();
    const file = join(s.home, ".cursor", "hooks.json");
    assert.equal(await runSetup(s.e, io(), opts(s, { hook: "no" })), 0);
    assert.equal(existsSync(file), false);
    const mine = '{\n  "version": 1,\n  "hooks": {\n    "sessionStart": [{ "command": "./hooks/session-init.sh" }],\n    "stop": [{ "command": "./hooks/audit.sh" }]\n  }\n}\n';
    writeFileSync(file, mine);
    assert.equal(await runSetup(s.e, io(), opts(s)), 0);
    const v = JSON.parse(readFileSync(file, "utf8")) as { hooks: { sessionStart: Array<{ command: string }>; stop: unknown[] } };
    assert.equal(v.hooks.sessionStart[0].command, "./hooks/session-init.sh");
    assert.match(v.hooks.sessionStart[1].command, /hook cursor-session-start/);
    assert.equal(v.hooks.stop.length, 1);
    assert.equal(await runSetup(s.e, io(), opts(s, { undo: true })), 0);
    assert.equal(readFileSync(file, "utf8"), mine);
  });

  test("hook cursor-session-start answers additional_context for the workspace folder, {} when there is nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-cursor-hook-"));
    roots.push(dir);
    const dbPath = join(dir, "state.db");
    const empty = await runHook("cursor-session-start", JSON.stringify({ session_id: "c-1", workspace_roots: [dir] }), { dbPath, dataDir: dir });
    assert.equal(empty, "{}");
    const st = new Store(dbPath);
    st.create({ title: "Deploys go through the staging branch", body: "decided in review" });
    st.close();
    const out = await runHook("cursor-session-start", JSON.stringify({ session_id: "c-2", workspace_roots: [dir], is_background_agent: false, composer_mode: "agent" }), { dbPath, dataDir: dir });
    const j = JSON.parse(out) as { additional_context?: string; hookSpecificOutput?: unknown };
    assert.equal(j.hookSpecificOutput, undefined, "Cursor's shape, not Claude Code's");
    assert.match(String(j.additional_context), /staging branch/);
    assert.equal(await runHook("cursor-session-start", "not json", { dbPath, dataDir: dir }).then((x) => typeof JSON.parse(x)), "object", "garbage stdin still gives valid JSON");
  });
});
