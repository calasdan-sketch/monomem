// Device sync follow-up: the dashboard's "Use Monomem on another computer" section. It explains `monomem sync setup` in plain
// words; its button runs that command (and only that command) behind the local sign-in, like every computer-touching route.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { setUiRunner } from "../src/api/routes-ui.js";
import { mintLoginCode } from "../src/login-code.js";
import { DB_PATH } from "../src/config.js";
import { SETTINGS_JS } from "../src/ui/js-settings.js";

const ADMIN = "a".repeat(40);
const SYNC_JSON = join(dirname(DB_PATH), "sync.json");
afterEach(() => {
  setUiRunner(null);
  rmSync(SYNC_JSON, { force: true });
});

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const s = new Store(":memory:");
  const server = createApiServer(s, [{ token: ADMIN, scope: "admin", label: "primary" }]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    s.close();
  }
}
const call = (base: string, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  fetch(base + path, { method: o.method ?? "GET", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json", ...(o.headers ?? {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) });
async function localHeader(base: string): Promise<Record<string, string>> {
  const r = (await (await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: mintLoginCode(Date.now(), false) }) })).json()) as { local_session: string };
  return { "X-Monomem-Local": r.local_session };
}

describe("dashboard: Use Monomem on another computer", () => {
  test("the key alone cannot read or start sync setup (an app over HTTP cannot reach this computer)", async () => {
    let ran = 0;
    setUiRunner(async () => (ran++, { code: 0, output: "" }));
    await withServer(async (base) => {
      for (const [m, p, b] of [["GET", "/ui/sync", undefined], ["POST", "/ui/sync/setup", { target: "C:\\OneDrive\\Monomem" }]] as const) {
        const r = await call(base, p, { method: m, body: b });
        assert.equal(r.status, 403, p);
        assert.equal(((await r.json()) as { local_required: boolean }).local_required, true);
      }
      assert.equal(ran, 0);
    });
  });

  test("with the local session the button runs `monomem sync setup <target> [--name]` and nothing else; odd input is refused", async () => {
    const runs: string[][] = [];
    setUiRunner(async (args) => (runs.push(args), { code: 0, output: "Set up. Next steps: ..." }));
    await withServer(async (base) => {
      const headers = await localHeader(base);
      const ok = await call(base, "/ui/sync/setup", { method: "POST", body: { target: "  C:\\Users\\me\\OneDrive\\Monomem ", name: "Work laptop" }, headers });
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { ok: boolean }).ok, true);
      await call(base, "/ui/sync/setup", { method: "POST", body: { target: "git@github.com:me/memory.git" }, headers });
      for (const body of [{}, { target: "" }, { target: "--auto" }, { target: "a\nb" }, { target: "x".repeat(1001) }, { target: "ok", name: "-x" }, { target: "ok", name: "n".repeat(41) }, { target: 5 }]) {
        assert.equal((await call(base, "/ui/sync/setup", { method: "POST", body, headers })).status, 400, JSON.stringify(body).slice(0, 60));
      }
      assert.deepEqual(runs, [
        ["sync", "setup", "C:\\Users\\me\\OneDrive\\Monomem", "--name", "Work laptop"],
        ["sync", "setup", "git@github.com:me/memory.git"],
      ]);
    });
  });

  test("GET /ui/sync says whether sync is set up, and never shows a password inside an address", async () => {
    await withServer(async (base) => {
      const headers = await localHeader(base);
      assert.deepEqual(await (await call(base, "/ui/sync", { headers })).json(), { set: false });
      writeFileSync(SYNC_JSON, JSON.stringify({ kind: "git", target: "https://me:hunter2@example.com/m.git", repo: "r", keyFile: "k", auto: true, everyMinutes: 30 }));
      const j = (await (await call(base, "/ui/sync", { headers })).json()) as { set: boolean; kind: string; where: string; auto: boolean; every_minutes: number };
      assert.equal(j.set, true);
      assert.equal(j.kind, "git");
      assert.equal(j.auto, true);
      assert.equal(j.every_minutes, 30);
      assert.doesNotMatch(JSON.stringify(j), /hunter2|keyFile|"k"/);
    });
  });

  test("docs: upgrading.md warns about the extra commit per archived note while a 1.5 computer still syncs", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = readFileSync(new URL("../../docs/upgrading.md", import.meta.url), "utf8");
    assert.match(doc, /one extra commit \(or file write\) per archived note\*\* until both are upgraded/);
  });

  test("Settings explains it in plain words and the button posts the folder and name", async () => {
    assert.match(SETTINGS_JS, /Use Monomem on another computer/);
    assert.match(SETTINGS_JS, /monomem sync setup/);
    assert.match(SETTINGS_JS, /Never put it in the shared folder/);
    const els = new Map<string, any>();
    const el = (id: string): any => els.get(id) ?? (els.set(id, { value: "", innerHTML: "", textContent: "" }), els.get(id));
    const calls: Array<{ path: string; body: unknown }> = [];
    const ctx: any = {
      $: el, esc: (s: string) => String(s), toast() {}, say() {},
      api: async (path: string, o?: { body?: string }) => (calls.push({ path, body: o?.body ? JSON.parse(o.body) : undefined }), { ok: true, code: 0, output: "Set up." }),
    };
    vm.createContext(ctx);
    vm.runInContext(SETTINGS_JS, ctx);
    el("sync_target").value = "D:\\Dropbox\\Monomem";
    el("sync_name").value = "Home PC";
    await ctx.syncSetup();
    assert.deepEqual(calls, [
      { path: "/ui/sync/setup", body: { target: "D:\\Dropbox\\Monomem", name: "Home PC" } },
      { path: "/ui/sync", body: undefined }, // after a good setup the status line is refreshed
    ]);
    assert.match(el("sync_out").innerHTML, /Set up\./);
  });
});
