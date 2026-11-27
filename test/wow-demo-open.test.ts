import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { startDemoSession, DEMO_POISON, openBrowser, removeDirLoudly } from "../src/cli/demo-open.js";
import { lintContent } from "../src/lint.js";
import { EventEmitter } from "node:events";
import { DB_PATH } from "../src/config.js";

describe("monomem demo --open", () => {
  test("seeds keyed writers, a held poison write and two false notes on a throwaway store, then deletes it", async () => {
    const realBefore = existsSync(DB_PATH);
    const s = await startDemoSession();
    try {
      assert.ok(s.dir.startsWith(tmpdir()), "the demo folder is a temp folder");
      assert.notEqual(s.dir, DB_PATH);
      assert.ok(s.seeded.held >= 1);
      assert.equal(s.seeded.good, 4);
      assert.equal(s.seeded.falseNotes, 2);
      const url = s.dashboardUrl();
      assert.match(url, new RegExp(`^${s.base.replace(/\./g, "\\.")}/#code=[0-9a-f]{32}$`));
      assert.ok(url.startsWith("http://127.0.0.1:"), "loopback only");
    } finally {
      s.stop();
    }
    assert.equal(existsSync(s.dir), false, "the demo folder is deleted on stop");
    assert.equal(existsSync(DB_PATH), realBefore, "the configured store was not created or touched");
    s.stop(); // twice is fine
    assert.ok(!readdirSync(tmpdir()).includes(s.dir.split(/[\\/]/).pop()!));
  });

  test("the poison text is one the write check holds (the real linter says so)", () => {
    const hits = lintContent({ title: "deploy checklist", body: DEMO_POISON });
    assert.ok(hits.some((h) => h.category === "injection"), JSON.stringify(hits));
  });

  test("31-M3: when the browser cannot be opened the address is shown", () => {
    const shown: string[] = [];
    const fake = (() => {
      const e = new EventEmitter() as EventEmitter & { unref(): void };
      e.unref = () => undefined;
      setImmediate(() => e.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })));
      return e;
    }) as never;
    openBrowser("http://127.0.0.1:1/#code=x", (why) => shown.push(why), fake);
    return new Promise<void>((r) => setImmediate(() => setImmediate(() => { assert.deepEqual(shown, ["ENOENT"]); r(); })));
  });

  test("31-M4: a folder that cannot be deleted is reported, not forgotten", () => {
    const warned: string[] = [];
    const never = (): void => { throw new Error("EBUSY: resource busy"); };
    assert.equal(removeDirLoudly("C:/tmp/demo-x", never, (m) => warned.push(m), () => undefined), false);
    assert.match(warned.join(""), /could not delete the demo folder .*demo-x .*EBUSY.*delete it by hand/);
    assert.equal(removeDirLoudly("C:/tmp/demo-y", () => undefined, (m) => warned.push(m), () => undefined), true);
  });
});
