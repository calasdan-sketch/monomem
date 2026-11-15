// 1.5.0 (round 2, F-06): a background edge build that fails is remembered in the database (doctor reads it) and cleared by the next success.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("F-06 a failed background edge build shows in edgeBuildFailures(), survives a reopen, and clears after a good build", async () => {
  const dir = mkdtempSync(join(tmpdir(), "om-f06-"));
  const save = process.env.MONOMEM_EDGE_SYNC_MAX;
  process.env.MONOMEM_EDGE_SYNC_MAX = "1"; // more than one note in a namespace: the index is built in the background
  try {
    const db = join(dir, "state.db");
    delete process.env.MONOMEM_EDGE_SYNC_MAX;
    const seedStore = new Store(db);
    for (let i = 0; i < 3; i++) seedStore.create({ namespace: "big", title: `n${i}`, body: `alpha ${i}` });
    seedStore.close();
    process.env.MONOMEM_EDGE_SYNC_MAX = "1";
    const s = new Store(db); // fresh: no index in memory, three notes live
    const raw = s as unknown as { edgeText: (...a: unknown[]) => string };
    raw.edgeText = () => {
      throw new Error("boom in the build");
    };
    s.create({ namespace: "big", title: "four", body: "alpha beta" });
    await wait(100);
    const f = s.edgeBuildFailures();
    assert.equal(f.length, 1);
    assert.equal(f[0].namespace, "big");
    assert.match(f[0].error, /boom in the build/);
    s.close();

    const again = new Store(db);
    assert.equal(again.edgeBuildFailures().length, 1, "another process (doctor) sees it");
    again.create({ namespace: "big", title: "three", body: "alpha delta" }); // starts a build that works
    await wait(200);
    assert.deepEqual(again.edgeBuildFailures(), []);
    again.close();
  } finally {
    if (save === undefined) delete process.env.MONOMEM_EDGE_SYNC_MAX;
    else process.env.MONOMEM_EDGE_SYNC_MAX = save;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a store left open by a failed assertion */
    }
  }
});
