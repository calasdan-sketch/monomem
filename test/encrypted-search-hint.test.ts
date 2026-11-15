import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// 1.5.0 final honesty panel: with encryption on, keyword search does not see note bodies. A search that finds nothing must
// say so, or "No relevant notes found." reads as "nothing in memory mentions it".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { PROJECT_ROOT } from "../src/config.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");

test("a 0-result search on a store with encrypted bodies says bodies were not searched; a plain store does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-enc-hint-"));
  try {
    const db = join(dir, "state.db");
    const env: NodeJS.ProcessEnv = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
    delete env.MONOMEM_KEY_FILE;
    const s = new Store(db);
    s.create({ title: "deploy notes", body: "the staging port is zebrafish8443", tags: [] });
    s.close();
    const plain = spawnSync(process.execPath, [CLI, "search", "unicornword"], { encoding: "utf8", env });
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /bodies/);

    ensureKey(dir);
    const s2 = new Store(db);
    s2.create({ title: "sealed one", body: "the staging port is narwhal9443", tags: [] });
    assert.ok(s2.encryptedCount() > 0, "the second note is sealed");
    s2.close();
    const enc = spawnSync(process.execPath, [CLI, "search", "narwhal9443"], { encoding: "utf8", env });
    assert.equal(enc.status, 0, enc.stderr);
    assert.match(enc.stdout, /No relevant notes found\./);
    assert.match(enc.stdout, /encrypted.*bod(y|ies).*not searched/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
