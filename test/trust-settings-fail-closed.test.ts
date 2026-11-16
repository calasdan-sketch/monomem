// 1.5.0 (round 2, A3): a damaged trust setting in _meta fails CLOSED (more protection), never open, and doctor can name it.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store, QuarantinedError } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";

const setMetaRaw = (s: Store, key: string, value: string): void => {
  s.captureDb().prepare("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};
afterEach(() => setProcessWriter(""));

describe("A3 damaged trust settings fail closed", () => {
  test("approve-first: a cut value holds every agent write instead of turning approval off", () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    s.setApproveFirst("work", true);
    const good = s.captureDb().prepare("SELECT value FROM _meta WHERE key = 'approve_first'").get() as { value: string };
    setMetaRaw(s, "approve_first", good.value.slice(0, -1));
    setProcessWriter("stdio:agent");
    assert.throws(() => s.create({ namespace: "work", title: "agent write" }), QuarantinedError);
    assert.throws(() => s.create({ namespace: "other", title: "agent write" }), QuarantinedError, "unknown list: every namespace is approve-first");
    assert.ok(s.damagedTrustSettings().includes("approve_first"));
    // release-gate S5: what status/doctor/GET /approve-first read says the same as enforcement: on everywhere.
    assert.equal(s.approveFirstAll(), true, "a damaged list reads as approve-first on every namespace");
    setProcessWriter("cli");
    s.setApproveFirst("work", true); // setting it again repairs the list (doctor says so)
    assert.equal(s.approveFirstAll(), false);
    assert.deepEqual(s.approveFirstNamespaces(), ["work"]);
    s.close();
  });

  test("an unknown confirm mode means enforce, not label", () => {
    const s = new Store(":memory:");
    setMetaRaw(s, "confirm_mode", "enforc");
    assert.equal(s.confirmSettings().mode, "enforce");
    assert.ok(s.damagedTrustSettings().includes("confirm_mode"));
    s.close();
  });

  test("a damaged revocation list makes no key trusted", () => {
    const s = new Store(":memory:");
    setMetaRaw(s, "revoked_attester_keys", "{not json");
    assert.equal(s.isKeyRevoked("any-key-id"), true);
    assert.ok(s.damagedTrustSettings().includes("revoked_attester_keys"));
    s.close();
  });

  test("a damaged pause list pauses every agent writer; the operator still writes and can clear it", () => {
    const s = new Store(":memory:");
    setMetaRaw(s, "flood_paused", "[\"a\"");
    setProcessWriter("stdio:agent");
    assert.throws(() => s.create({ title: "agent write" }), /paused/i);
    setProcessWriter("cli");
    assert.ok(s.create({ title: "operator write" }).id > 0);
    assert.equal(s.resumeWriter("stdio:agent"), true);
    setProcessWriter("stdio:agent");
    assert.ok(s.create({ title: "agent write after resume" }).id > 0);
    assert.deepEqual(s.damagedTrustSettings(), []);
    s.close();
  });

  test("intact or missing settings are not reported", () => {
    const s = new Store(":memory:");
    assert.deepEqual(s.damagedTrustSettings(), []);
    assert.equal(s.confirmSettings().mode, "label");
    assert.equal(s.isKeyRevoked("x"), false);
    s.close();
  });
});

describe("A3 doctor names a damaged trust setting", () => {
  test("runHealth warns with the setting and how to reset it", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { runHealth } = await import("../src/health.js");
    const dir = mkdtempSync(join(tmpdir(), "om-a3-"));
    try {
      const dbPath = join(dir, "t.db");
      const s = new Store(dbPath);
      setMetaRaw(s, "confirm_mode", "enforc");
      s.close();
      const r = await runHealth({ dbPath });
      const c = r.checks.find((x: { id: string }) => x.id === "trust-settings");
      assert.ok(c, JSON.stringify(r.checks.map((x: { id: string }) => x.id)));
      assert.equal(c!.status, "warn");
      assert.match(c!.text, /confirm_mode .*monomem config set confirm-mode/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
