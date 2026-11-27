// Round 4 speed work: the conflict check's reused facts about the newer note, the one-commit link record, and the git-free
// answer outside a repository. Each must give exactly what the slower code gave.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { flagConflict } from "../src/conflict-detect.js";
import { recordConflictLinks, linksAmong } from "../src/store/conflict-links.js";
import { gitSignals } from "../src/context-inject.js";

describe("flagConflict keeps no state between different newer notes", () => {
  const prev = { title: "Deploy region", body: "We deploy production to us-east-1." };
  const a = { title: "Deploy region", body: "We deploy production to eu-west-1." };
  const b = { title: "Deploy region", body: "Production deploys to us-east-1 happen on Tuesdays." };
  test("alternating newer notes give each its own answer, and the same note the same answer twice", () => {
    assert.equal(flagConflict(prev, a)?.kind, "value");
    assert.equal(flagConflict(prev, b), null);
    assert.equal(flagConflict(prev, a)?.kind, "value");
    assert.equal(flagConflict(prev, a)?.kind, "value");
    assert.equal(flagConflict(prev, b), null);
  });
});

describe("recordConflictLinks", () => {
  test("several links land together, a repeat replaces instead of doubling, and an open transaction is respected", () => {
    const s = new Store(":memory:");
    recordConflictLinks(s, 9, [{ id: 1, kind: "value", why: "w1" }, { id: 2, kind: "negation", why: "w2" }]);
    recordConflictLinks(s, 9, [{ id: 1, kind: "switch", why: "w3" }]);
    const rows = linksAmong(s, [9]).sort((x, y) => x.older - y.older);
    assert.deepEqual(rows.map((r) => [r.older, r.kind]), [[1, "switch"], [2, "negation"]]);
    s.db.exec("BEGIN");
    recordConflictLinks(s, 10, [{ id: 3, kind: "value", why: "w" }]);
    s.db.exec("ROLLBACK");
    assert.equal(linksAmong(s, [10]).length, 0, "the caller's rollback still undoes the link");
    s.close();
  });
});

describe("gitSignals outside a repository", () => {
  test("answers an empty branch and no files (what three failing git calls returned)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-nogit-"));
    try {
      assert.deepEqual(await gitSignals(dir), { branch: "", diffFiles: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
