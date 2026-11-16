// 1.5.0 (round 2, S-01): approving or keeping a held write over REST replies with ids only, like MCP: the flagged text is
// never echoed back to whoever approved it.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store, QuarantinedError } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { setProcessWriter } from "../src/actor.js";

const CANARY = "HELDCANARYZQX";
afterEach(() => setProcessWriter(""));
function hold(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof QuarantinedError) return e.quarantineId;
    throw e;
  }
  assert.fail("not held");
}

describe("S-01 REST held actions reply with ids only", () => {
  test("approve and keep-history replies carry no held text", async () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    s.create({ namespace: "p", title: "seed" });
    s.setApproveFirst("p", true);
    setProcessWriter("stdio:agent");
    const q1 = hold(() => s.create({ namespace: "p", title: "approve me", body: `${CANARY} one` }));
    const q2 = hold(() => s.create({ namespace: "p", title: "keep me", body: `${CANARY} two` }));
    setProcessWriter("cli");
    const fix = s.create({ namespace: "p", title: "keep me corrected", body: "fixed" });
    setProcessWriter("");
    const server = createApiServer(s, "tok-admin-1234567890");
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { Authorization: "Bearer tok-admin-1234567890", "Content-Type": "application/json" };
    try {
      const a = await fetch(`${base}/quarantine/${q1}/approve`, { method: "POST", headers: H });
      const at = await a.text();
      assert.equal(a.status, 200, at);
      assert.doesNotMatch(at, new RegExp(CANARY));
      assert.ok(Number(JSON.parse(at).note_id) > 0);
      const k = await fetch(`${base}/quarantine/${q2}/keep-history`, { method: "POST", headers: H, body: JSON.stringify({ by: fix.id }) });
      const kt = await k.text();
      assert.equal(k.status, 200, kt);
      assert.doesNotMatch(kt, new RegExp(CANARY));
      assert.equal(JSON.parse(kt).superseded_by, fix.id);
      assert.ok(Number(JSON.parse(kt).note_id) > 0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });
});
