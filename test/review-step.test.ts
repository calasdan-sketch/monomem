// 1.5.0 (R1-21): `monomem review --step` walks the backlog one note at a time: y confirms (as a person), n skips, q stops.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";
import { reviewSteps } from "../src/review-step.js";

afterEach(() => setProcessWriter(""));

describe("R1-21 review --step", () => {
  test("y confirms as a person, n skips, q stops; each note shows title, writer, why and the start of its text", async () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    const a = s.create({ title: "first web note", body: "alpha text from a page", outside: true });
    const b = s.create({ title: "second web note", body: "beta", outside: true });
    const c = s.create({ title: "third web note", body: "gamma", outside: true });
    const answers = ["y", "n", "q"];
    const out: string[] = [];
    const res = await reviewSteps(s, s.reviewList(), { ask: async () => answers.shift() ?? "q", print: (l) => out.push(l) });
    assert.deepEqual(res, { confirmed: 1, skipped: 1, left: 1 });
    const kinds = (id: number) => (s.captureDb().prepare("SELECT kind FROM confirmations WHERE note_id = ?").all(id) as Array<{ kind: string }>).map((r) => r.kind);
    const ids = s.reviewList().map((r) => r.id);
    const done = [a.id, b.id, c.id].filter((id) => !ids.includes(id));
    assert.equal(done.length, 1);
    assert.deepEqual(kinds(done[0]), ["human"]);
    const text = out.join("\n");
    assert.match(text, /web note/);
    assert.match(text, /by cli/);
    assert.match(text, /1 confirmed, 1 skipped, 1 left/);
    s.close();
  });

  test("an unknown answer asks again; end of input stops", async () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    s.create({ title: "web note", body: "x", outside: true });
    const answers = ["maybe", "n"];
    const out: string[] = [];
    const res = await reviewSteps(s, s.reviewList(), { ask: async () => answers.shift() ?? null, print: (l) => out.push(l) });
    assert.deepEqual(res, { confirmed: 0, skipped: 1, left: 0 });
    assert.match(out.join("\n"), /Type y, n or q/);
    s.close();
  });
});
