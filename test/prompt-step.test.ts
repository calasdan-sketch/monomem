// C17: the one prompt-time step (src/prompt/step.ts, wired into the UserPromptSubmit hook).
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { receiptAdd, receiptShown } from "../src/receipts.js";
import { promptStep, promptRecallOn, rarestKeywords } from "../src/prompt/step.js";
import { runHook } from "../src/hook.js";
import { newNotesSince } from "../src/context-inject.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const SID = "sess-prompt";
afterEach(() => {
  delete process.env.MONOMEM_ACCESS_LOG_DAYS;
});

/** Record a user prompt (and anything else) the way the capture hook does. */
function event(s: Store, ev: string, raw: Record<string, unknown>, sid = SID, at = new Date()): void {
  recordEvent(s, normalizeHookInput(ev as never, { session_id: sid, cwd: "/work/app", ...raw }, at), "default");
}
const step = (s: Store, prompt: string, recall = true, sid = SID) => {
  event(s, "user-prompt", { prompt }, sid);
  return promptStep(s, sid, prompt, { recall });
};

describe("prompt recall (step 4)", () => {
  test("off by default: MONOMEM_PROMPT_RECALL must say on", () => {
    assert.equal(promptRecallOn({}), false);
    assert.equal(promptRecallOn({ MONOMEM_PROMPT_RECALL: "on" }), true);
    assert.equal(promptRecallOn({ MONOMEM_PROMPT_RECALL: "off" }), false);
  });

  test("top 3 for the prompt's rare words; titles only; never a note this session was shown, a held note or a never-show note", () => {
    const s = new Store(":memory:");
    const shownAtStart = s.create({ title: "zorblax cache warmup", body: "warm the zorblax cache" }).id;
    const held = s.create({ title: "zorblax eviction rule from a web page", body: "x", outside: true } as never).id;
    const never = s.create({ title: "zorblax private scratch", body: "x", tags: ["never-show"] }).id;
    const a = s.create({ title: "zorblax sharding plan", body: "shards by tenant" }).id;
    const b = s.create({ title: "zorblax ttl choice", body: "ttl is 30s" }).id;
    for (let i = 0; i < 30; i++) s.create({ title: `deploy note ${i}`, body: "deploy the service" });
    event(s, "session-start", {});
    receiptAdd(s, { sessionId: SID, namespace: "", client: "", shown: [{ id: shownAtStart, why: "{recent 0d}", tokens: 5 }] });
    const r = step(s, "how does the zorblax layer deploy?");
    assert.ok(r.recalled.includes(a) && r.recalled.includes(b), `${r.recalled}`);
    for (const id of [shownAtStart, held, never]) assert.ok(!r.recalled.includes(id), `#${id} pushed`);
    assert.match(r.text, /May be relevant to this message \(titles only/);
    assert.doesNotMatch(r.text, /shards by tenant/, "titles only, never the body");
    assert.match(r.cost, /^\(Monomem prompt step: ~\d+ tokens, \d+ ms\. MONOMEM_PROMPT_RECALL=off turns it off\.\)$/);
    // Written on the same receipt as session start (why=prompt), so the next prompt does not push them again.
    const after = receiptShown(s, SID);
    assert.ok(after.has(a) && after.has(b) && after.has(shownAtStart));
    assert.deepEqual(step(s, "zorblax again please").recalled.filter((id) => id === a || id === b), []);
    s.close();
  });

  test("a busy writer gets at most 2 of the 3 when another writer matches too", () => {
    const s = new Store(":memory:");
    as("bot", () => {
      for (let i = 0; i < 6; i++) s.create({ title: `quellin status ${i}`, body: "quellin ok" });
    });
    const human = as("claude-code", () => s.create({ title: "quellin retry decision", body: "retry three times" }).id);
    for (let i = 0; i < 40; i++) s.create({ title: `filler ${i}`, body: "nothing" });
    event(s, "session-start", {});
    const r = step(s, "what did we decide about quellin?");
    assert.ok(r.recalled.includes(human), `${r.recalled}`);
    assert.equal(r.recalled.length, 3);
    s.close();
  });

  test("common words push nothing; only the rarest 6 keywords are searched", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 40; i++) s.create({ title: `deploy service ${i}`, body: "deploy the service again" });
    assert.deepEqual(rarestKeywords(s, "deploy the service"), []);
    event(s, "session-start", {});
    assert.deepEqual(step(s, "deploy the service").recalled, []);
    assert.ok(rarestKeywords(s, "alpha bravo charlie delta echo foxtrot golf hotel deploy").length <= 6);
    s.close();
  });

  test("receipts off (MONOMEM_ACCESS_LOG_DAYS=0): nothing is pushed, rather than the same notes every prompt", () => {
    process.env.MONOMEM_ACCESS_LOG_DAYS = "0";
    const s = new Store(":memory:");
    s.create({ title: "zorblax sharding plan", body: "x" });
    for (let i = 0; i < 10; i++) s.create({ title: `other ${i}`, body: "y" });
    event(s, "session-start", {});
    const r = step(s, "zorblax?");
    assert.deepEqual(r.recalled, []);
    assert.equal(r.cost, "");
    s.close();
  });
});

describe("retired-note and known-fix notices (steps 2 and 3)", () => {
  test("a note the session was shown, then replaced by another writer: said once, naming the replacement", () => {
    const s = new Store(":memory:");
    const old = as("alice", () => s.create({ title: "deploy target fly", body: "fly" }).id);
    event(s, "session-start", {});
    receiptAdd(s, { sessionId: SID, namespace: "", client: "", shown: [{ id: old, why: "", tokens: 1 }] }, Date.now() - 60_000);
    const neu = as("codex", () => s.create({ title: "deploy target render", body: "render" }).id);
    const at = new Date().toISOString();
    s.captureDb().prepare("UPDATE notes SET superseded_by = ?, superseded_at = ?, archived_at = ? WHERE id = ?").run(neu, at, at, old);
    const r1 = step(s, "hello");
    assert.match(r1.text, new RegExp(`#${old} "deploy target fly", which you were shown, was replaced by #${neu} \\(codex\\)`));
    assert.doesNotMatch(step(s, "hello again").text, /which you were shown/, "said once");
    s.close();
  });

  test("a flagged note: said once; with steps off nothing is said", () => {
    const s = new Store(":memory:");
    const n = as("alice", () => s.create({ title: "api port 8080", body: "8080" }).id);
    event(s, "session-start", {});
    receiptAdd(s, { sessionId: SID, namespace: "", client: "", shown: [{ id: n, why: "", tokens: 1 }] }, Date.now() - 60_000);
    as("bob", () => s.flagNote(n, "port moved to 9090"));
    assert.doesNotMatch(step(s, "x", false).text, /flagged/);
    assert.match(step(s, "y").text, new RegExp(`#${n} "api port 8080", which you were shown, was flagged as possibly wrong by bob`));
    s.close();
  });

  test("a command that failed since the last prompt, with a bugfix note from an earlier session: one 'Seen before' line", () => {
    const s = new Store(":memory:");
    event(s, "session-start", {}, "old-session");
    const fix = s.create({ title: "Fixed failing `npm test`", body: "`npm test` failed (missing await) and passes after the changes to src/a.ts." }, { kind: "observation", sessionId: "old-session", obsType: "bugfix" }).id;
    event(s, "session-start", {});
    step(s, "run the tests");
    event(s, "post-tool-failure", { tool_name: "Bash", tool_input: { command: "npm test" }, error: "1 failing" });
    const r = step(s, "it failed, why?");
    assert.match(r.text, new RegExp(`Known fix:\\nSeen before: that command failed in an earlier session and was fixed\\. #${fix} `));
    event(s, "post-tool-failure", { tool_name: "Bash", tool_input: { command: "npm test" }, error: "1 failing" });
    assert.doesNotMatch(step(s, "again").text, /Seen before/, "said once per session");
    s.close();
  });
});

describe("new-by-others under a busy writer (r2-improvement #9)", () => {
  test("a writer with many new notes is one summary line, not five of its titles", () => {
    const s = new Store(":memory:");
    event(s, "session-start", {}, SID, new Date(Date.now() - 60_000));
    as("bot", () => {
      for (let i = 0; i < 12; i++) s.create({ title: `bot log ${i}`, body: "x" });
    });
    const human = as("cursor", () => s.create({ title: "switched to pnpm", body: "x" }).id);
    event(s, "user-prompt", { prompt: "hi" });
    const text = newNotesSince(s, SID);
    assert.match(text, new RegExp(`#${human} by cursor:`));
    assert.doesNotMatch(text, /bot log/);
    assert.match(text, /bot saved 12 notes \(#\d+-#\d+\); memory_catch_up lists them\./);
    s.close();
  });
});

describe("the hook (one store open per prompt, untrusted banner kept)", () => {
  test("user-prompt with MONOMEM_PROMPT_RECALL=on prints the banner, the recall and the cost line after the block", async () => {
    const home = mkdtempSync(join(tmpdir(), "mm-prompt-"));
    const db = join(home, "state.db");
    try {
      const s = new Store(db);
      s.create({ title: "zorblax sharding plan", body: "x" });
      for (let i = 0; i < 10; i++) s.create({ title: `other ${i}`, body: "y" });
      s.close();
      const env = { ...process.env, MONOMEM_PROMPT_RECALL: "on" };
      // No session start here: it would show all 11 notes, and a note the session was shown is never pushed again.
      const out = await runHook("user-prompt", JSON.stringify({ session_id: "h1", cwd: home, prompt: "zorblax?" }), { dbPath: db, dataDir: home, env });
      const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
      assert.match(ctx, /SECURITY NOTICE \(block [0-9a-f]{6}\)/);
      assert.match(ctx, /zorblax sharding plan/);
      assert.match(ctx, /END OF STORED NOTES \(block [0-9a-f]{6}\)\. [^\n]*\n\(Monomem prompt step: ~\d+ tokens, \d+ ms\./);
      // Off (the default): the same prompt pushes nothing.
      const off = await runHook("user-prompt", JSON.stringify({ session_id: "h2", cwd: home, prompt: "zorblax?" }), { dbPath: db, dataDir: home, env: { ...process.env } });
      assert.equal(off, "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
