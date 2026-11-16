// setup: the automatic memory hooks (planHooks) are appended next to the user's own hooks, are idempotent, need consent
// (--capture or a typed y; --yes alone never adds them, only the start-of-session hook), and come out again with --undo. Everything runs in temp dirs.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOps } from "../src/jsonc-edit.js";
import { CAPTURE_HOOKS, DEFAULT_OPTIONS, planHooks, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";

// A fixed path that names the tool: hook detection looks for monomem/onememory/claude-bridge in the CLI path, so the test
// must not depend on what the checkout folder happens to be called. planHooks never opens it.
const CLI = "/opt/monomem/dist/src/cli.js";
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function sandbox(): { e: SetupEnv; settings: string; db: string } {
  const root = mkdtempSync(join(tmpdir(), "om-hooks-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), '{"mcpServers":{"monomem":{"type":"stdio","command":"monomem","args":["mcp"]}}}');
  return {
    settings: join(home, ".claude", "settings.json"),
    db: join(root, "data", "state.db"),
    e: { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-10-30T12:00:00Z") },
  };
}
function io(answers: string[] = [], interactive = false): SetupIO & { all: () => string; asked: string[] } {
  const l: string[] = [];
  const asked: string[] = [];
  return { interactive, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async (p) => (asked.push(p), answers.shift() ?? ""), all: () => l.join("\n"), asked };
}
const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, ...o });
const USER_HOOKS = JSON.stringify({ theme: "dark", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "prettier --write" }] }], Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, 2);
const read = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

describe("setup: automatic memory hooks", () => {
  test("an existing hook is recognised whatever the install path's name and casing", () => {
    // The hook line lives in the USER's settings file and holds whatever path
    // was installed then: an older name from before a rename, and any casing
    // the user's filesystem happens to use. Failing to recognise it means
    // setup bolts a SECOND copy in beside the one they already have.
    //
    // Both halves of this were real. Matching only the current name broke every
    // upgrade from OneMemory; matching case-sensitively then broke CI, whose
    // checkout is at D:\a\Monomem\Monomem while the author's is lowercase.
    for (const dir of ["monomem", "Monomem", "onememory", "OneMemory", "claude-bridge"]) {
      const s = sandbox();
      const cli = `C:/work/${dir}/dist/src/cli.js`;
      writeFileSync(
        s.settings,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: `node "${cli}" hook session-start` }] }],
            UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "${cli}" hook user-prompt` }] }],
          },
        }),
      );
      const r = planHooks(s.e, opts(), undefined, { recall: true, capture: false });
      assert.equal(r.change, null, `a hook at .../${dir}/... is ours and must not be duplicated`);
      assert.equal(r.already, true, `.../${dir}/... should report already-installed`);
    }
  });

  test("planHooks appends one entry per event next to the user's hooks; async for the background ones", () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    const r = planHooks(s.e, opts(), undefined, { recall: true, capture: true });
    assert.ok(r.change);
    const after = JSON.parse(applyOps(r.change!.before ?? "", r.change!.ops));
    assert.equal(after.theme, "dark");
    assert.equal(after.hooks.PostToolUse[0].hooks[0].command, "prettier --write", "the user's hook stays first and unchanged");
    assert.equal(after.hooks.Stop[0].hooks[0].command, "say done");
    assert.match(after.hooks.SessionStart[0].hooks[0].command, /hook session-start$/);
    assert.equal(after.hooks.SessionStart[0].hooks[0].async, undefined, "session-start is synchronous (its output is the context)");
    for (const h of CAPTURE_HOOKS) {
      const mine = after.hooks[h.on].at(-1).hooks[0];
      assert.match(mine.command, new RegExp(`cli\\.js" hook ${h.event}$`));
      assert.equal(mine.async === true, h.async, h.on);
    }
    assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].async, undefined);
    assert.equal(after.hooks.PostToolUse.at(-1).hooks[0].async, true);
    assert.equal(after.hooks.PreToolUse.at(-1).matcher, "Read", "file context runs on Read only");
    assert.equal(after.hooks.PreToolUse.at(-1).hooks[0].async, undefined, "file context is synchronous (its output is the context)");
  });

  test("idempotent: once installed nothing more is planned; an existing recall hook is kept, not replaced", () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    const r = planHooks(s.e, opts(), undefined, { recall: true, capture: true });
    writeFileSync(s.settings, applyOps(USER_HOOKS, r.change!.ops));
    assert.deepEqual(planHooks(s.e, opts(), undefined, { recall: true, capture: true }), { change: null, already: true });
    const s2 = sandbox();
    writeFileSync(s2.settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node "${CLI.replace(/\\/g, "/")}" recall --budget-ms 800` }] }] } }));
    const r2 = planHooks(s2.e, opts(), undefined, { recall: true, capture: true });
    const after = JSON.parse(applyOps(readFileSync(s2.settings, "utf8"), r2.change!.ops));
    assert.equal(after.hooks.SessionStart.length, 1, "the recall hook is enough at session start");
    assert.match(after.hooks.SessionStart[0].hooks[0].command, /recall --budget-ms/);
    assert.ok(after.hooks.PostToolUse);
  });

  test("runSetup: --yes alone adds no capture hooks; --yes --capture does; --undo takes only ours out", async () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    // --yes alone adds only the start-of-session hook (owner decision, 1.5.0); with --no-hook it adds nothing at all.
    assert.equal(await runSetup(s.e, io(), opts({ yes: true, hook: "no", db: s.db })), 0);
    assert.deepEqual(read(s.settings), JSON.parse(USER_HOOKS), "no consent, no hooks");
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, db: s.db, hook: "yes", capture: "yes" })), 0, out.all());
    const after = read(s.settings);
    assert.ok(after.hooks.SessionStart && after.hooks.UserPromptSubmit && after.hooks.SessionEnd);
    assert.equal(after.hooks.PostToolUse.length, 2);
    assert.match(out.all(), /record what Claude does in every project/);
    // Running again changes nothing.
    const again = io();
    assert.equal(await runSetup(s.e, again, opts({ yes: true, db: s.db, hook: "yes", capture: "yes" })), 0);
    assert.deepEqual(read(s.settings), after);
    // The user edits their own hook in the meantime; undo keeps that and removes only ours.
    const edited = { ...after, theme: "light" };
    writeFileSync(s.settings, JSON.stringify(edited, null, 2));
    assert.equal(await runSetup(s.e, io(), opts({ undo: true })), 0);
    const back = read(s.settings);
    assert.equal(back.theme, "light");
    assert.deepEqual(back.hooks.PostToolUse, JSON.parse(USER_HOOKS).hooks.PostToolUse);
    assert.deepEqual(back.hooks.Stop, JSON.parse(USER_HOOKS).hooks.Stop);
    assert.ok(!JSON.stringify(back).includes(" hook "), "no monomem hook is left");
  });

  test("interactive: the consent question is asked and a no keeps capture out", async () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    const t = io(["y", "y", "n"], true);
    assert.equal(await runSetup(s.e, t, opts({ db: s.db })), 0, t.all());
    assert.ok(t.asked.some((q) => q.startsWith("Also record what your assistant does in every project (files, commands, errors), stored only on this machine?")));
    const after = read(s.settings);
    assert.ok(after.hooks.SessionStart, "the start-of-session hook was accepted");
    assert.equal(after.hooks.UserPromptSubmit, undefined, "capture was declined");
    assert.match(after.hooks.SessionStart[0].hooks[0].command, /recall --budget-ms/);
  });
});

describe("setup --yes preview (final panel, ease B2)", () => {
  test("the preview shows only what --yes adds: the start-of-session hook, not the capture hooks it leaves out", async () => {
    const s = sandbox();
    const out = io();
    assert.equal(await runSetup(s.e, out, opts({ yes: true, db: s.db })), 0, out.all());
    const after = read(s.settings);
    assert.ok(after.hooks.SessionStart, "--yes adds the start-of-session hook");
    assert.equal(after.hooks.PostToolUse, undefined, "--yes leaves capture out");
    assert.doesNotMatch(out.all(), /PostToolUse/, "the preview must not show a capture hook that is never written");
    assert.doesNotMatch(out.all(), /record what/i);
  });

  test("SubagentStart is wired only when MONOMEM_SUBAGENT_MEMORY=on is chosen, with the launcher line and the settings env; undo takes both out", () => {
    const s = sandbox();
    writeFileSync(s.settings, USER_HOOKS);
    const off = JSON.parse(applyOps(USER_HOOKS, planHooks(s.e, opts(), undefined, { recall: true, capture: true }).change!.ops));
    assert.equal(off.hooks.SubagentStart, undefined, "off by default: no SubagentStart hook");
    assert.equal(off.env, undefined);
    const on = { ...s.e, env: { ...s.e.env, MONOMEM_SUBAGENT_MEMORY: "on" } };
    const r = planHooks(on, opts(), undefined, { recall: true, capture: true });
    const after = JSON.parse(applyOps(USER_HOOKS, r.change!.ops));
    const cmd: string = after.hooks.SubagentStart.at(-1).hooks[0].command;
    assert.equal(cmd, `node "${CLI}" hook subagent-start`, "the same launcher line as every other hook (selfShellLine)");
    assert.equal(after.hooks.SubagentStart.at(-1).hooks[0].async, undefined, "synchronous: its output is the pack");
    assert.equal(after.env.MONOMEM_SUBAGENT_MEMORY, "on", "the hook processes see the switch through Claude Code's settings env");
    assert.match(r.change!.lines.join("\n"), /subagents/);
    const undone = JSON.parse(applyOps(applyOps(USER_HOOKS, r.change!.ops), r.change!.inverse));
    assert.equal((undone.hooks.SubagentStart ?? []).length, 0);
    assert.equal(undone.env?.MONOMEM_SUBAGENT_MEMORY, undefined);
    // Installed: nothing more to plan.
    writeFileSync(s.settings, applyOps(USER_HOOKS, r.change!.ops));
    assert.deepEqual(planHooks(on, opts(), undefined, { recall: true, capture: true }), { change: null, already: true });
  });
});
