// Final panel (ease B1): `review` must never say "Nothing waits" while writes are held for a person.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";

test("review and review --step point to held writes instead of a false all-clear", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-review-held-"));
  try {
    const db = join(dir, "state.db");
    const s = new Store(db);
    s.setApproveFirst("default", true);
    setProcessWriter("stdio:agent");
    try {
      s.create({ namespace: "default", title: "held one", body: "b" });
    } catch {
      /* held: the write is refused into quarantine */
    } finally {
      setProcessWriter("");
    }
    assert.equal(s.listQuarantine().length, 1, "the write is held");
    s.close();
    const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
    const cli = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), ...args], { env, encoding: "utf8" });
    for (const args of [["review"], ["review", "--step"]]) {
      const r = cli(...args);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stdout, /^Nothing waits/m, args.join(" "));
      assert.match(r.stdout, /1 held write waits for your decision: monomem quarantine/, args.join(" "));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
