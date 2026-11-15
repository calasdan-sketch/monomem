// 1.5.0 (round 2, infra HIGH-3): doctor only looks. An older database is reported, not upgraded behind running apps' backs.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { downgradeTo } from "./legacy-db.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("doctor does not migrate", () => {
  test("a v20 database stays v20 after doctor, and doctor says how to upgrade", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-doctor-old-"));
    try {
      const dbPath = join(dir, "state.db");
      const s = new Store(dbPath);
      s.create({ title: "kept", body: "x" });
      s.close();
      downgradeTo(dbPath, 20);
      assert.equal(Store.peekSchemaVersion(dbPath), 20);
      const r = spawnSync(process.execPath, ["--no-warnings", CLI, "doctor"], { env: { ...process.env, MONOMEM_HOME: dir, HOME: dir, MONOMEM_DB_PATH: dbPath }, encoding: "utf8" });
      const out = r.stdout + r.stderr;
      assert.match(out, /schema v20.*doctor did not upgrade it/);
      assert.match(out, /monomem ls/);
      assert.equal(Store.peekSchemaVersion(dbPath), 20, "doctor left the schema alone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
