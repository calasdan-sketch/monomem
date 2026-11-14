// 1.4.0 fix round 3 (final live security check): the dashboard session that skips the read rule is a person's only.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { actorStore } from "../src/actor.js";
import { setTtyCheck } from "../src/taint.js";
import { mintLoginCode } from "../src/login-code.js";
import { resolveToken } from "../src/config.js";

const as = <T>(label: string, f: () => T): T => actorStore.run({ label, authed: true }, f);
afterEach(() => setTtyCheck(undefined));

async function setup() {
  const store = new Store(":memory:");
  const notes = [1, 2, 3].map((i) => as("research-bot", () => store.create({ title: `page ${i}`, outside: true })));
  const primary = resolveToken();
  const other = "other-admin-token-ffffffffffffffffffffffff";
  const http = createApiServer(store, [
    { token: primary, scope: "admin", label: "owner" },
    { token: other, scope: "admin", label: "other-admin" },
  ]);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const login = async (code: string) => (await (await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).json()) as any;
  const confirm = async (tok: string, id: number, ds?: string) => {
    const h: Record<string, string> = { authorization: `Bearer ${tok}`, "content-type": "application/json", ...(ds ? { "x-monomem-dashboard": ds } : {}) };
    await fetch(`${base}/notes`, { headers: h }); // the dashboard lists the note first: this key has now read it
    return (await (await fetch(`${base}/notes/${id}/confirm`, { method: "POST", headers: h, body: JSON.stringify({ source: "checked in the dashboard" }) })).json()) as any;
  };
  const close = async () => {
    await new Promise<void>((r) => {
      http.closeAllConnections();
      http.close(() => r());
    });
    store.close();
  };
  return { notes, primary, other, login, confirm, close };
}

describe("H: a sign-in link minted without a terminal gives no dashboard session", () => {
  test("`monomem open --print` from a script: signed in, but confirms count as the key's", async () => {
    const t = await setup();
    try {
      const r = spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "open", "--print"], { env: { ...process.env }, encoding: "utf8" });
      const code = /#code=([0-9a-f]{32})/.exec(r.stdout)?.[1];
      assert.ok(code, r.stdout + r.stderr);
      const l = await t.login(code!);
      assert.equal(l.token, t.primary, "still signs in");
      assert.equal(l.dashboard_session, undefined, JSON.stringify(Object.keys(l)));
      assert.match(l.notice, /Confirms here count as the key's, because this link wasn't opened from a terminal/);
      const c = await t.confirm(t.primary, t.notes[0].id);
      assert.equal(c.reason, "read_it", JSON.stringify(c));
    } finally {
      await t.close();
    }
  });

  test("minted at a terminal (the owner's normal path): dashboard session, confirm counts as admin", async () => {
    const t = await setup();
    try {
      setTtyCheck(() => true);
      const l = await t.login(mintLoginCode());
      assert.ok(l.dashboard_session);
      assert.equal(l.notice, undefined);
      const c = await t.confirm(t.primary, t.notes[0].id, l.dashboard_session);
      assert.equal(c.counted, true, JSON.stringify(c));
      assert.equal(c.kind, "admin");
    } finally {
      await t.close();
    }
  });
});

describe("M: a dashboard session is bound to the key that signed in, and expires", () => {
  test("another admin key with the session: read rule applies; after 8 hours: read rule applies", async () => {
    const t = await setup();
    try {
      setTtyCheck(() => true);
      const l = await t.login(mintLoginCode());
      const stolen = await t.confirm(t.other, t.notes[0].id, l.dashboard_session);
      assert.equal(stolen.reason, "read_it", JSON.stringify(stolen));
      const fresh = await t.confirm(t.primary, t.notes[2].id, l.dashboard_session);
      assert.equal(fresh.counted, true, JSON.stringify(fresh));
      const realNow = Date.now;
      const later = realNow() + 8 * 3_600_000 + 60_000;
      Date.now = () => later;
      try {
        const expired = await t.confirm(t.primary, t.notes[1].id, l.dashboard_session);
        assert.equal(expired.reason, "read_it", JSON.stringify(expired));
      } finally {
        Date.now = realNow;
      }
    } finally {
      await t.close();
    }
  });
});
