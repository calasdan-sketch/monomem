// Notice apps installed later (app-detect.ts): the first look only records what is there; an app installed afterwards is
// offered (Needs you + /ui/apps "new") until it is connected or declined; a connection that would not start is offered
// for Repair, and setup for that app fixes it. At most one look a day. Everything runs in a temp HOME.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO } from "../src/setup.js";
import { appsNeedingYou, checkApps, maybeCheckApps, readAppDetect } from "../src/app-detect.js";
import { needsYou, needsYouLine } from "../src/ui/needs-you.js";
import { updateUiSettings } from "../src/ui/settings.js";
import { Store } from "../src/store.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function sandbox(): { e: SetupEnv; home: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), "om-detect-"));
  roots.push(root);
  const home = join(root, "home");
  const data = join(root, "data");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(data, { recursive: true });
  return { home, data, e: { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: data }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-17T12:00:00Z") } };
}
const io = (): SetupIO => ({ interactive: false, out: () => {}, err: () => {}, ask: async () => "" });
const T0 = new Date("2026-11-17T12:00:00Z");

describe("notice apps installed later", () => {
  test("first look records what is there; a later install is offered until connected; Not this one hides it", async () => {
    const s = sandbox();
    const first = await checkApps(s.e, s.data, T0);
    assert.deepEqual(first.baseline, ["cursor"]);
    assert.deepEqual(first.new, [], "apps present at the first look were already offered by setup");
    mkdirSync(join(s.home, ".kiro"), { recursive: true });
    const later = await checkApps(s.e, s.data, new Date(T0.getTime() + 86_400_000));
    assert.deepEqual(later.new, [{ id: "kiro", label: "Kiro" }]);
    const store = new Store(join(s.data, "state.db"));
    try {
      const n = needsYou(store, { dataDir: s.data, conflicts: false });
      const item = n.items.find((i) => i.kind === "apps")!;
      assert.equal(item.view, "settings");
      assert.match(item.text, /Kiro was installed after Monomem was set up/);
      assert.match(needsYouLine(store, { dataDir: s.data }), /1 app to connect or repair/);
      updateUiSettings({ declined_apps: ["kiro"] }, s.data);
      assert.equal(needsYou(store, { dataDir: s.data, conflicts: false }).items.some((i) => i.kind === "apps"), false, "declined: never offered again");
    } finally {
      store.close();
    }
    updateUiSettings({ declined_apps: [] }, s.data);
    assert.equal(await runSetup(s.e, io(), { ...DEFAULT_OPTIONS, yes: true, noDoctor: true, noTestNote: true, only: ["kiro"], hook: "no", capture: "no" }), 0);
    assert.deepEqual((await checkApps(s.e, s.data, T0)).new, [], "connected: no longer offered");
  });

  test("a connection that would not start is offered for Repair; setup for that app fixes it", async () => {
    const s = sandbox();
    writeFileSync(join(s.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { monomem: { command: "/gone/node", args: ["/gone/dist/src/cli.js", "mcp"], env: { MONOMEM_CLIENT: "cursor" } } } }));
    const st = await checkApps(s.e, s.data, T0);
    assert.equal(st.repair.length, 1);
    assert.equal(st.repair[0].id, "cursor");
    assert.match(st.repair[0].problem!, /no longer exists/);
    assert.equal(appsNeedingYou(s.data, ["cursor"]).repair.length, 1, "Not this one does not hide a broken connection");
    assert.equal(await runSetup(s.e, io(), { ...DEFAULT_OPTIONS, yes: true, noDoctor: true, noTestNote: true, only: ["cursor"], hook: "no", capture: "no" }), 0);
    assert.deepEqual((await checkApps(s.e, s.data, T0)).repair, []);
  });

  test("at most one look a day", async () => {
    const s = sandbox();
    assert.ok(await maybeCheckApps(s.e, s.data, T0), "no state yet: looks");
    mkdirSync(join(s.home, ".qwen"), { recursive: true });
    assert.equal(await maybeCheckApps(s.e, s.data, new Date(T0.getTime() + 3_600_000)), null, "an hour later: no look");
    assert.deepEqual(readAppDetect(s.data)!.new, []);
    const next = await maybeCheckApps(s.e, s.data, new Date(T0.getTime() + 86_400_000));
    assert.deepEqual(next!.new.map((a) => a.id), ["qwen"]);
  });
});
