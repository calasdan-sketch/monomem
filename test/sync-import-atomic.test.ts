// r8: kill -9 during `sync import` then a re-run made a duplicate note (stress/sync-kill.mjs: 3 of 5 rounds): the note was
// committed, its sync link in a second transaction. The link now goes in with the note: all or nothing.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";

test("a failure between a sync-imported note and its link leaves no note; the re-run imports it once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-syncatomic-"));
  const a = new Store(join(dir, "a.db"), { bodyIndex: "off" });
  const b = new Store(join(dir, "b.db"), { bodyIndex: "off" });
  try {
    a.create({ title: "release cadence", body: "ship weekly on thursdays" });
    exportMarkdown(a, join(dir, "vault"));
    const real = b.syncLink.bind(b);
    b.syncLink = (): void => { throw new Error("killed here"); };
    await assert.rejects(importMarkdown(b, join(dir, "vault")), /killed here/);
    assert.equal(b.countAll(), 0, "the note must not be saved without its link");
    b.syncLink = real;
    await importMarkdown(b, join(dir, "vault"));
    await importMarkdown(b, join(dir, "vault"));
    assert.equal(b.countAll(), 1, "imported once, not once per run");
  } finally {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
