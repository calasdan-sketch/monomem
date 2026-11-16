// 1.5.0 (R1-19): pinning a note from outside content explains admin vs person when an admin confirm already exists.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { setProcessWriter, actorStore } from "../src/actor.js";
import { promotionRefusal } from "../src/taint.js";

describe("R1-19 pin refusal explains admin vs person", () => {
  test("no confirm yet: the short refusal", () => {
    assert.equal(promotionRefusal("pin", 7), "Can't pin: this note came from outside content. A person must confirm it first: monomem confirm 7");
  });

  test("REST: an admin-confirmed note still can't be pinned, and the reply says why", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const n = store.create({ title: "vendor price", body: "99", outside: true });
    setProcessWriter("");
    const c = actorStore.run({ label: "primary", authed: true }, () => store.confirm(n.id, { admin: true, source: "checked in the dashboard" }));
    assert.equal(c?.kind, "admin");
    const server = createApiServer(store, "tok-admin-1234567890");
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { Authorization: "Bearer tok-admin-1234567890", "Content-Type": "application/json" };
    try {
      const res = await fetch(`${base}/pinned`, { method: "PUT", headers: H, body: JSON.stringify({ id: n.id, pinned: true }) });
      assert.equal(res.status, 400);
      const err = ((await res.json()) as any).error as string;
      assert.match(err, /admin \(dashboard\) confirm/);
      assert.match(err, /lets it into session start but not into pins/);
      assert.match(err, new RegExp(`monomem confirm ${n.id}`));
      assert.equal(store.read(n.id)!.pinned, undefined);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});
