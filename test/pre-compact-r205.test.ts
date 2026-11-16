import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// R2-05: `monomem hook pre-compact` (Claude Code's PreCompact event) distils the session so far into its summary before
// the context is compacted: same redaction, origin stamps, exit-0 and spool rules as the post-tool capture hook. Setup
// registers it for Claude Code only, and --undo takes it out again. Temp folders only.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { runHook } from "../src/hook.js";
import { SPOOL_FILE } from "../src/capture.js";
import { ORIGIN_TOOL_PREFIX } from "../src/taint.js";
import { CAPTURE_HOOKS, DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";

const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "om-r205-"));
  roots.push(d);
  return d;
};
const ev = (o: Record<string, unknown>): string => JSON.stringify({ session_id: "sess-pc", cwd: "/w/app", ...o });

describe("R2-05 hook pre-compact", () => {
  test("writes the interim session summary with the session's origin stamps, redacted", async () => {
    const dir = tmp();
    const db = join(dir, "state.db");
    new Store(db).close();
    const opts = { dbPath: db, dataDir: dir, env: {} };
    await runHook("user-prompt", ev({ prompt: `fix the date parser, key ${SECRET}` }), opts);
    await runHook("post-tool", ev({ tool_name: "WebFetch", tool_input: { url: "https://example.com" }, tool_response: "page text" }), opts);
    await runHook("post-tool", ev({ tool_name: "Edit", tool_input: { file_path: "/w/app/src/date.ts" }, tool_response: {} }), opts);
    const s0 = new Store(db);
    assert.equal(s0.list({ kinds: ["summary"], limit: 10 }).notes.length, 0, "no summary before the compaction");
    s0.close();
    assert.equal(await runHook("pre-compact", ev({ hook_event_name: "PreCompact", trigger: "auto", custom_instructions: "" }), opts), "");
    const s = new Store(db);
    try {
      const sums = s.list({ kinds: ["summary"], limit: 10 }).notes;
      assert.equal(sums.length, 1);
      assert.equal(sums[0].session_id, "sess-pc");
      assert.match(sums[0].body, /Request: fix the date parser/);
      assert.match(sums[0].body, /src\/date\.ts/);
      assert.ok(sums[0].tags.includes(ORIGIN_TOOL_PREFIX + "WebFetch"), sums[0].tags.join()); // read outside content: stamped
      assert.ok(!sums[0].body.includes(SECRET), "redacted like every captured event");
      // A second compaction later in the session updates the same summary, never a second one.
      await runHook("post-tool", ev({ tool_name: "Edit", tool_input: { file_path: "/w/app/src/other.ts" }, tool_response: {} }), opts);
      await runHook("pre-compact", ev({ trigger: "manual" }), opts);
      const again = s.list({ kinds: ["summary"], limit: 10 }).notes;
      assert.equal(again.length, 1);
      assert.match(again[0].body, /src\/other\.ts/);
    } finally {
      s.close();
    }
  });

  test("garbage on stdin, or no database: prints nothing and never throws; without a database the event is spooled", async () => {
    const dir = tmp();
    const opts = { dbPath: join(dir, "missing.db"), dataDir: dir, env: {} };
    for (const junk of ["", "not json", "[1,2]", "{\"session_id\":5}", "\u0000\u0001"]) assert.equal(await runHook("pre-compact", junk, opts), "");
    assert.equal(await runHook("pre-compact", ev({ trigger: "auto" }), opts), "");
    const spool = join(dir, SPOOL_FILE);
    assert.ok(existsSync(spool));
    assert.match(readFileSync(spool, "utf8"), /"event":"pre-compact"/);
  });
});

describe("R2-05 setup registers PreCompact for Claude Code only", () => {
  const CLI = "/opt/monomem/dist/src/cli.js";
  const io = (): SetupIO => ({ interactive: false, out: () => {}, err: () => {}, ask: async () => "" });
  const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, ...o });

  test("CAPTURE_HOOKS (the Claude Code list) has PreCompact -> hook pre-compact, in the background", () => {
    const h = CAPTURE_HOOKS.find((x) => x.on === "PreCompact");
    assert.ok(h);
    assert.equal(h.event, "pre-compact");
    assert.equal(h.async, true);
  });

  test("--capture adds it to ~/.claude/settings.json; --undo removes it", async () => {
    const root = tmp();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), '{"mcpServers":{"monomem":{"type":"stdio","command":"monomem","args":["mcp"]}}}');
    const settings = join(home, ".claude", "settings.json");
    writeFileSync(settings, JSON.stringify({ theme: "dark" }));
    const e: SetupEnv = { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-14T12:00:00Z") };
    assert.equal(await runSetup(e, io(), opts({ yes: true, db: join(root, "data", "state.db"), hook: "yes", capture: "yes", only: ["claude-code"] })), 0);
    const after = JSON.parse(readFileSync(settings, "utf8"));
    assert.match(after.hooks.PreCompact[0].hooks[0].command, / hook pre-compact\b/);
    assert.equal(await runSetup(e, io(), opts({ undo: true })), 0);
    const back = JSON.parse(readFileSync(settings, "utf8"));
    assert.equal(back.hooks?.PreCompact, undefined);
    assert.ok(!JSON.stringify(back).includes("pre-compact"));
  });
});
