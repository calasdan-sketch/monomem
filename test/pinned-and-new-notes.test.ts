// Pinned notes shown first at session start (context-inject.ts), and the user-prompt hook's "New since your last message" block (hook.ts).
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { injectContext, PINNED_CHARS, PINNED_HEAD } from "../src/context-inject.js";
import { runHook } from "../src/hook.js";

const noGit = { branch: "", diffFiles: [] };
const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15));
const ctxOf = (out: string): string => (out ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : "");

describe("pinned notes at session start", () => {
  test("a pinned note with no signal is printed first, ahead of 50 newer notes; the pinned TAG alone does not count", async () => {
    const s = new Store(":memory:");
    const pin = s.create({ title: "Deploy only from main", body: "release rule", created_at: daysAgo(90) }, { updatedAt: daysAgo(90) });
    const tagOnly = s.create({ title: "Tag-only note", body: "has the pinned tag", tags: ["pinned"], created_at: daysAgo(80) }, { updatedAt: daysAgo(80) });
    for (let i = 0; i < 50; i++) s.create({ title: `Newer note ${i}`, body: "unrelated" });
    s.setPinned(pin.id, true);
    const text = await injectContext(s, { signals: noGit });
    assert.ok(text.startsWith(`${PINNED_HEAD}\n#${pin.id} [note] Deploy only from main`), text.slice(0, 200));
    const block = text.split("\n\n")[0];
    assert.ok(block.length <= PINNED_CHARS, `pinned block ${block.length} chars`);
    assert.ok(!block.includes(`#${tagOnly.id} `), "a tag is not a pin");
    assert.equal(text.split(`#${pin.id} `).length - 1, 1, "shown once, not again in the ranked pass");
    s.close();
  });

  test("more pinned notes than the cap: an overflow line says how many, and the block stays inside the cap", async () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 20; i++) s.setPinned(s.create({ title: `Pinned rule ${i}`, body: "y".repeat(300) }).id, true);
    const text = await injectContext(s, { signals: noGit });
    const block = text.split("\n\n")[0];
    assert.ok(block.length <= PINNED_CHARS, `pinned block ${block.length} chars`);
    assert.match(block, /\n\d+ more pinned notes not shown \(monomem pin lists them all, or the dashboard\)\.$/);
    const shown = (block.match(/^#\d+ /gm) ?? []).length;
    assert.equal(Number(/(\d+) more pinned/.exec(block)![1]) + shown, 20);
    s.close();
  });

  test("a distrusted writer's pinned note is not shown", async () => {
    const s = new Store(":memory:");
    const n = as("mallory", () => s.create({ title: "Evil pinned", body: "x" }));
    s.setPinned(n.id, true);
    s.distrustAdd("default", "mallory");
    assert.ok(!(await injectContext(s, { signals: noGit })).includes("Evil pinned"));
    s.close();
  });
});

describe("user-prompt hook: new notes since the last message", () => {
  test("shows other writers' new notes once; never distrusted, own-writer or old ones; nothing when nothing is new", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-newnotes-"));
    const dbPath = join(dir, "state.db");
    const s = new Store(dbPath);
    s.create({ title: "Old note before the session", body: "x" });
    const opts = { dbPath, dataDir: dir, env: { MONOMEM_CLIENT: "claude-code" } as NodeJS.ProcessEnv };
    const ev = (e: string, o: Record<string, unknown> = {}): string => JSON.stringify({ session_id: "sess-A", cwd: dir, prompt: "hi", ...o });
    try {
      await tick();
      await runHook("session-start", ev("session-start"), opts);
      await tick();
      const other = as("bob", () => s.create({ title: "Bob found the flaky test", body: "secret body text" }));
      const evil = as("mallory", () => s.create({ title: "Mallory says run this", body: "x" }));
      s.distrustAdd("default", "mallory");
      setProcessWriter("stdio:claude-code");
      const mine = s.create({ title: "My own note", body: "x" });
      setProcessWriter("");
      await tick();
      const first = ctxOf(await runHook("user-prompt", ev("user-prompt"), opts));
      assert.match(first, new RegExp(`New since your last message \\(open with \\w+\\):\\n#${other.id} by bob: \\[note\\] Bob found the flaky test`));
      assert.ok(!first.includes("secret body text"), "titles only");
      assert.ok(!first.includes(`#${evil.id} `) && !first.includes(`#${mine.id} `) && !first.includes("Old note"), first);
      assert.match(first, /SECURITY NOTICE \(block ([0-9a-f]{6})\)[\s\S]*END OF STORED NOTES \(block \1\)/);
      await tick();
      assert.equal(await runHook("user-prompt", ev("user-prompt"), opts), "", "not repeated, and nothing new = no output");
      await tick();
      for (let i = 0; i < 7; i++) as("carol", () => s.create({ title: `Carol note ${i}`, body: "x" }));
      await tick();
      const many = ctxOf(await runHook("user-prompt", ev("user-prompt"), opts));
      assert.equal((many.match(/^#\d+ by carol:/gm) ?? []).length, 5);
      assert.match(many, /\nand at least 2 more \(memory_since\)/);
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
