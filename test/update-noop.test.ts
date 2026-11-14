// 1.5.0 R1-02: a write that changes nothing is a no-op (no rev bump, no updated_at, no history row, no flood count).
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import type { AddressInfo } from "node:net";

afterEach(() => setProcessWriter(""));

describe("R1-02 an unchanged write is a no-op", () => {
  test("same title, body and tags: rev, updated_at and history stay; the reply says unchanged", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio:bot");
    const n = s.create({ title: "t", body: "same body", tags: ["a", "b"] });
    s.captureDb().prepare("UPDATE notes SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(n.id);
    const logRows = () => Number((s.captureDb().prepare("SELECT COUNT(*) AS c FROM change_log WHERE note_id = ?").get(n.id) as { c: number }).c);
    const before = logRows();
    const r = s.update(n.id, { title: "t", body: "same body", tags: ["b", "a"], confidence: undefined })!;
    assert.equal(r.unchanged, true);
    const after = s.read(n.id)!;
    assert.equal(after.rev, n.rev);
    assert.equal(after.updated_at, "2020-01-01T00:00:00.000Z");
    assert.equal(logRows(), before, "no change_log row");
    s.close();
  });

  test("a real change still bumps rev and is not marked unchanged", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio:bot");
    const n = s.create({ title: "t", body: "one" });
    const r = s.update(n.id, { body: "two" })!;
    assert.equal(r.unchanged, undefined);
    assert.equal(r.rev, n.rev + 1);
    s.close();
  });

  test("an unchanged write does not count against the flood limit", () => {
    process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "1000"; // setup-env turns the guard off; counting needs it on
    const s = new Store(":memory:");
    setProcessWriter("stdio:bot");
    const n = s.create({ title: "t", body: "b" });
    const counted = () => Number((s.captureDb().prepare("SELECT COUNT(*) AS c FROM write_rate").get() as { c: number }).c);
    const before = counted();
    s.update(n.id, { body: "b" });
    assert.equal(counted(), before);
    s.update(n.id, { body: "c" });
    assert.equal(counted(), before + 1, "a real write is counted");
    s.close();
    process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "0";
  });

  test("a stale if_rev on an unchanged write is still refused", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio:bot");
    const n = s.create({ title: "t", body: "b" });
    s.update(n.id, { body: "c" });
    assert.throws(() => s.update(n.id, { body: "c" }, { ifRev: n.rev }), /stale write/);
    s.close();
  });

  test("setting only a new confidence or tag is a change", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio:bot");
    const n = s.create({ title: "t", body: "b" });
    assert.equal(s.update(n.id, { confidence: 0.4 })!.rev, n.rev + 1);
    assert.equal(s.update(n.id, { tags: ["new"] })!.rev, n.rev + 2);
    s.close();
  });

  test("REST PUT with nothing new answers 200 with unchanged: true and the rev stays", async () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    const n = s.create({ title: "t", body: "b" });
    const http = createApiServer(s, [{ token: "k".repeat(24), scope: "admin", label: "boss" }]);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    try {
      const h = { authorization: `Bearer ${"k".repeat(24)}`, "content-type": "application/json" };
      const same = (await (await fetch(`${base}/notes/${n.id}`, { method: "PUT", headers: h, body: JSON.stringify({ body: "b" }) })).json()) as any;
      assert.equal(same.unchanged, true);
      assert.equal(same.note.rev, n.rev);
      assert.equal(same.note.unchanged, undefined, "the flag is on the reply, not inside the note");
      const diff = (await (await fetch(`${base}/notes/${n.id}`, { method: "PUT", headers: h, body: JSON.stringify({ body: "c" }) })).json()) as any;
      assert.equal(diff.unchanged, undefined);
      assert.equal(diff.note.rev, n.rev + 1);
    } finally {
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      s.close();
    }
  });
});
