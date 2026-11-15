// 1.5.0 (round 2, F3): restore tells an encrypted backup from a plain one by body_enc, not by what the plain text starts with.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { inspectBackup } from "../src/restore.js";

function backup(fill: (s: Store) => void): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "om-f3-"));
  const path = join(dir, "backup.db");
  const s = new Store(path);
  try {
    fill(s);
  } finally {
    s.close();
  }
  return { dir, path };
}

describe("F3 restore detects encrypted backups", () => {
  test("a backup whose bodies are sealed (body_enc) is reported encrypted", () => {
    const b = backup((s) => {
      const n = s.create({ title: "sealed", body: "x" });
      s.captureDb().prepare("UPDATE notes SET body = '', body_enc = 'v2:AAAA' WHERE id = ?").run(n.id);
    });
    try {
      assert.equal(inspectBackup(b.path).encrypted, true);
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  test("a plain note that happens to start with 'v2:' is not mistaken for encryption", () => {
    const b = backup((s) => void s.create({ title: "release notes", body: "v2: the second release" }));
    try {
      assert.equal(inspectBackup(b.path).encrypted, false);
    } finally {
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});
