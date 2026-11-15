// 1.5.0 (round 2, S-04): a process that opened the database before a newer build upgraded it refuses to write.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SchemaNewerError, SCHEMA_VERSION } from "../src/store.js";

test("S-04 after another program moves the file to a newer schema, writes are refused and nothing is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-s04-"));
  const path = join(dir, "state.db");
  const a = new Store(path);
  try {
    a.create({ title: "before" });
    const other = new DatabaseSync(path);
    other.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    other.close();
    assert.throws(() => a.create({ title: "after" }), (e: unknown) => e instanceof SchemaNewerError && /restart this app/i.test((e as Error).message));
    const n = (a.captureDb().prepare("SELECT COUNT(*) c FROM notes WHERE title = 'after'").get() as { c: number }).c;
    assert.equal(n, 0);
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
