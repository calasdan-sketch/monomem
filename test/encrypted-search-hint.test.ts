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

test("a 0-result search says encrypted bodies were not searched only when they really were not (index off); a plain store never does", () => {
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
    // C-06: the CLI search builds the in-memory body index, so the sealed body IS searched and no notice is shown.
    const enc = spawnSync(process.execPath, [CLI, "search", "narwhal9443"], { encoding: "utf8", env });
    assert.equal(enc.status, 0, enc.stderr);
    assert.match(enc.stdout, /sealed one/);
    assert.doesNotMatch(enc.stdout, /not searched/);
    const miss = spawnSync(process.execPath, [CLI, "search", "unicornword"], { encoding: "utf8", env });
    assert.match(miss.stdout, /No relevant notes found\./);
    assert.doesNotMatch(miss.stdout, /not searched/, "bodies were searched: an empty result means nothing mentions it");
    // With the index turned off, bodies really are not searched: then (and only then) it says so.
    const off = spawnSync(process.execPath, [CLI, "search", "narwhal9443"], { encoding: "utf8", env: { ...env, MONOMEM_BODY_INDEX: "off" } });
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /No relevant notes found\./);
    assert.match(off.stdout, /encrypted.*bod(y|ies).*not searched/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("encrypt status with sealed bodies and the key file gone says the key is missing, not 'off'", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-enc-nokey-"));
  try {
    const db = join(dir, "state.db");
    const env: NodeJS.ProcessEnv = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
    delete env.MONOMEM_KEY_FILE;
    ensureKey(dir);
    const s = new Store(db);
    s.create({ title: "sealed", body: "secret body", tags: [] });
    s.close();
    rmSync(join(dir, ".key"));
    const r = spawnSync(process.execPath, [CLI, "encrypt", "status"], { encoding: "utf8", env });
    assert.doesNotMatch(r.stdout, /^encryption: off$/m, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /key file is missing at .*restore it from your backup/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
