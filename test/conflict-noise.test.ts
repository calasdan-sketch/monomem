// A broad overlap (many notes, one key) is "low" and never suggests replacing more than two notes at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { findConflicts, conflictReport, conflictLines } from "../src/conflicts.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);

test("five notes stating one key: low confidence, no multi-note supersede", () => {
  const s = new Store(":memory:");
  const vals = ["npm", "pnpm", "yarn", "bun", "deno"];
  vals.forEach((v, i) => as(`w${i}`, () => s.create({ title: `Package manager: ${v}`, body: "x" })));
  const rep = conflictReport(findConflicts(s));
  assert.ok(rep.groups.length >= 1);
  assert.ok(rep.groups.every((g) => g.confidence === "low"), JSON.stringify(rep.groups.map((g) => g.confidence)));
  const text = conflictLines(rep.groups).join("\n");
  assert.ok(!/supersede --old \d+,\d+,\d+/.test(text), text);
  assert.match(text, /not suggested/);
  s.close();
});

test("a clean two-note disagreement is still high and still offers the replace command", () => {
  const s = new Store(":memory:");
  as("a", () => s.create({ title: "Package manager: npm", body: "x" }));
  as("b", () => s.create({ title: "Package manager: pnpm", body: "x" }));
  const rep = conflictReport(findConflicts(s));
  assert.equal(rep.groups[0].confidence, "high");
  assert.match(conflictLines(rep.groups).join("\n"), /supersede --old \d+ --new-id/);
  s.close();
});
