// 1.5.0 (round 2, S-03): doctor and `encrypt status` tell the truth about encryption: a missing key fails doctor, and
// plaintext bodies next to a key are counted and reported.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { ensureKey, keyPath } from "../src/crypto.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (dir: string, args: string[]) =>
  spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { env: { ...process.env, MONOMEM_HOME: dir, ONEMEMORY_HOME: dir, HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db") }, encoding: "utf8" });

describe("S-03 encryption truth", () => {
  test("sealed notes with no key: doctor fails and names the key path", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-s03a-"));
    try {
      ensureKey(dir);
      const s = new Store(join(dir, "state.db"));
      s.create({ title: "sealed", body: "secret" });
      s.close();
      unlinkSync(keyPath(dir));
      const r = run(dir, ["doctor"]);
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /1 note.* encrypted.*key is missing/i);
      assert.ok((r.stdout + r.stderr).includes(keyPath(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a plaintext body next to a key: status counts it, doctor warns", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-s03b-"));
    try {
      const s = new Store(join(dir, "state.db"));
      s.create({ title: "plain", body: "written before the key existed" });
      s.close();
      ensureKey(dir);
      const st = run(dir, ["encrypt", "status"]);
      assert.match(st.stdout, /plaintext bodies: 1/);
      const d = run(dir, ["doctor"]);
      assert.match(d.stdout + d.stderr, /1 note body is not encrypted[\s\S]*monomem encrypt enable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
