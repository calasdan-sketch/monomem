// Release-gate load scenario (r2-improvement #1, plan section I): one busy writer must not push the team's settled decisions
// out of session start. 2,000 notes from one bot writer, written AFTER three real notes from another writer (two carry
// facts, one is a plain fix). Session start must still show all three, print every fact value on a "Project facts" line,
// and give the bot no more than 3 of the Recent lines.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { injectContext } from "../src/context-inject.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const noGit = { branch: "", diffFiles: [] };
const BOT = "bot-b4";

function busyStore(bot = 2000): { s: Store; real: number[] } {
  const s = new Store(":memory:");
  const real = as("claude-code", () => [
    s.create({ title: "Use pnpm, not npm", body: "We switched the repo to pnpm workspaces.", tags: ["fact:package_manager=pnpm"] }).id,
    s.create({ title: "Deploy target is fly.io", body: "Production deploys go to fly.io from main.", tags: ["fact:deploy_target=fly.io"] }).id,
    s.create({ title: "Flaky login test fix", body: "The login e2e test flaked on a missing await in the fixture; fixed by awaiting setup." }).id,
  ]);
  as(BOT, () => {
    for (let i = 0; i < bot; i++) s.create({ title: `bot log line ${i}`, body: `routine status ${i}: queue drained, nothing to report` });
  });
  return { s, real };
}

const recentLines = (text: string): string[] => {
  const m = /Recent memory \(\d+ notes?\):\n([\s\S]*?)(?:\n\n|$)/.exec(text);
  return m ? m[1].split("\n") : [];
};

describe("session start under a busy writer (release gate)", () => {
  test("2,000 notes from one writer: the 3 real notes, both fact values, and at most 3 Recent lines from the bot", async () => {
    const { s, real } = busyStore();
    const text = await injectContext(s, { signals: noGit });
    for (const id of real) assert.match(text, new RegExp(`(^|\n)#${id} `), `#${id} missing:\n${text}`);
    const facts = text.split("\n").find((l) => l.startsWith("Project facts:"));
    assert.ok(facts, text);
    assert.match(facts!, /package_manager=pnpm \(#1 /);
    assert.match(facts!, /deploy_target=fly\.io \(#2 /);
    const botRecent = recentLines(text).filter((l) => l.includes(BOT));
    assert.ok(botRecent.length <= 3, `bot holds ${botRecent.length} Recent lines:\n${text}`);
    // The rest of the bot is summed up, not silently dropped.
    assert.match(text, new RegExp(`${BOT}: \\d+\\+? more not listed here`));
    s.close();
  });

  test("a store with one writer is not capped: a solo user's session start is unchanged in size", async () => {
    const s = new Store(":memory:");
    as("claude-code", () => {
      for (let i = 0; i < 30; i++) s.create({ title: `note ${i}`, body: `body ${i}` });
    });
    const text = await injectContext(s, { signals: noGit });
    assert.equal(recentLines(text).length, 10);
    assert.doesNotMatch(text, /more not listed here/);
    s.close();
  });

  test("no facts: no Project facts line", async () => {
    const s = new Store(":memory:");
    s.create({ title: "plain", body: "plain" });
    assert.doesNotMatch(await injectContext(s, { signals: noGit }), /Project facts:/);
    s.close();
  });
});
