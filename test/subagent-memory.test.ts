// Subagent memory (r2-competition #2): SubagentStart pack + SubagentStop trail note, off by default.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { receiptAdd } from "../src/receipts.js";
import { runHook } from "../src/hook.js";
import { subagentMemoryOn } from "../src/prompt/subagent.js";

const ctxOf = (out: string): string => (out ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : "");

function world(): { home: string; db: string; ids: { shown: number; other: number; held: number } } {
  const home = mkdtempSync(join(tmpdir(), "mm-sub-"));
  const db = join(home, "state.db");
  const s = new Store(db);
  const shown = s.create({ title: "already in the main session", body: "x" }).id;
  const other = s.create({ title: "parser keeps comments", body: "y" }).id;
  const held = s.create({ title: "from a web page", body: "z", outside: true } as never).id;
  receiptAdd(s, { sessionId: "main", namespace: "", client: "", shown: [{ id: shown, why: "", tokens: 1 }] });
  s.close();
  return { home, db, ids: { shown, other, held } };
}

describe("subagent memory", () => {
  test("off by default", () => {
    assert.equal(subagentMemoryOn({}), false);
    assert.equal(subagentMemoryOn({ MONOMEM_SUBAGENT_MEMORY: "on" }), true);
  });

  test("SubagentStart: a pack inside the untrusted block, without held notes or notes the main session holds; once per type", async () => {
    const w = world();
    try {
      const on = { dbPath: w.db, dataDir: w.home, env: { ...process.env, MONOMEM_SUBAGENT_MEMORY: "on" } };
      const payload = JSON.stringify({ session_id: "main", cwd: w.home, agent_id: "a1", agent_type: "Explore" });
      assert.equal(await runHook("subagent-start", payload, { dbPath: w.db, dataDir: w.home, env: { ...process.env } }), "", "off by default");
      const out = await runHook("subagent-start", payload, on);
      assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName, "SubagentStart");
      const ctx = ctxOf(out);
      assert.match(ctx, /SECURITY NOTICE \(block [0-9a-f]{6}\)/);
      assert.match(ctx, new RegExp(`#${w.ids.other} \\[note\\] parser keeps comments`));
      assert.ok(!ctx.includes(`#${w.ids.shown} `), "the main session already holds it");
      assert.ok(!ctx.includes(`#${w.ids.held} `) && !ctx.includes("from a web page"), "held notes stay out");
      assert.equal(await runHook("subagent-start", payload, on), "", "once per subagent type per session");
      assert.notEqual(await runHook("subagent-start", JSON.stringify({ session_id: "main", cwd: w.home, agent_type: "Plan" }), on), "");
    } finally {
      rmSync(w.home, { recursive: true, force: true });
    }
  });

  test("SubagentStop: one trail note with what it reported and the files it read, linked to its pack", async () => {
    const w = world();
    try {
      const env = { ...process.env, MONOMEM_SUBAGENT_MEMORY: "on" };
      const opts = { dbPath: w.db, dataDir: w.home, env };
      await runHook("subagent-start", JSON.stringify({ session_id: "main", cwd: w.home, agent_type: "Explore" }), opts);
      await runHook("post-tool", JSON.stringify({ session_id: "main", cwd: w.home, tool_name: "Read", tool_input: { file_path: "src/parser.ts" }, tool_response: "..." }), opts);
      await runHook(
        "subagent-stop",
        JSON.stringify({ session_id: "main", cwd: w.home, agent_type: "Explore", last_assistant_message: "The parser drops comments in strict mode. Dead end: the lexer is fine." }),
        opts
      );
      const s = new Store(w.db);
      try {
        const trail = s.list({ kinds: ["observation"], withTags: ["subagent"], limit: 5 }).notes;
        assert.equal(trail.length, 1);
        assert.match(trail[0].title, /^Subagent Explore: The parser drops comments in strict mode\./);
        assert.match(trail[0].body, /Files read: src\/parser\.ts/);
        assert.ok(s.read(trail[0].id)!.derived_from?.includes(w.ids.other), JSON.stringify(s.read(trail[0].id)!.derived_from));
      } finally {
        s.close();
      }
    } finally {
      rmSync(w.home, { recursive: true, force: true });
    }
  });
});
