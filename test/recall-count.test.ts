// Session-start recall: the writer labels must not cost notes. 57 is what Monomem 1.2.1 shows for this exact store and budget.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { injectContext, WRITER_LEGEND } from "../src/context-inject.js";

test("same store, same budget: as many notes as 1.2.1, short writer labels, one legend line", async () => {
  const s = new Store(":memory:");
  const labels = ["cli", "stdio", "laptop-claude-code", "ci-bot"];
  for (let i = 0; i < 60; i++) actorStore.run({ label: labels[i % 4], authed: true }, () => s.create({ title: `Fixed note ${i} about subject ${i % 7}`, body: "body ".repeat(20 + (i % 5) * 10) }));
  const out = await injectContext(s, { signals: { branch: "", diffFiles: [] }, tokens: 1500 });
  const m = /Showing (\d+) of (\d+)/.exec(out)!;
  assert.ok(Number(m[1]) >= 57, `shows ${m[1]}, 1.2.1 showed 57`);
  assert.equal(out.split(WRITER_LEGEND).length, 2, "the writer explanation appears once");
  assert.match(out, /\(\d{4}-\d{2}-\d{2} by (cli|stdio|laptop-claude-code|ci-bot), ~\d+ tok\)/);
  assert.ok(!/ by cli \(/.test(out.split("Memory index")[1] ?? ""), "no long per-line writer explanation in index lines");
  s.close();
});
