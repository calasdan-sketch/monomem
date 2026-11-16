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

test("review --step names a flagged note instead of a false all-clear (final panel round 2, ease B2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-review-flag-"));
  try {
    const db = join(dir, "state.db");
    const s = new Store(db);
    const n = s.create({ namespace: "default", title: "a fact", body: "the deploy region is west" });
    setProcessWriter("stdio:cursor");
    try {
      assert.ok(s.flagNote(n.id, "looks wrong"), "flagged");
    } finally {
      setProcessWriter("");
    }
    s.close();
    const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
    const r = spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "review", "--step"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /^Nothing waits/m);
    assert.match(r.stdout, /1 flagged note waits: monomem review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
