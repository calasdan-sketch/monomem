import "./setup-env.js";
// 1.5.0 round 3 polish, item 2: message wording (no doubled prefix, upgrade text matches docs/upgrading.md, the time legend).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey, keyPath } from "../src/crypto.js";
import { timeLegend } from "../src/receipts.js";
import { PROJECT_ROOT } from "../src/config.js";

test("a missing key file error carries no 'monomem:' prefix of its own (the CLI adds none, stderr lines add [monomem])", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-msg-"));
  const db = join(dir, "state.db");
  process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log");
  try {
    const s = new Store(db);
    s.create({ title: "t", body: "secret body" });
    s.encryptAll(ensureKey(dir));
    s.close();
    unlinkSync(keyPath(dir));
    const s2 = new Store(db);
    try {
      assert.throws(
        () => s2.create({ title: "u", body: "x" }),
        (e: Error) => /^this database holds encrypted notes but the key file/.test(e.message) && !/monomem: /.test(e.message)
      );
    } finally {
      s2.close();
    }
  } finally {
    delete process.env.MONOMEM_AUDIT_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the 'newer than this build' message gives the same rollback steps as docs/upgrading.md", () => {
  const src = readFileSync(join(PROJECT_ROOT, "src", "store.ts"), "utf8");
  const doc = readFileSync(join(PROJECT_ROOT, "docs", "upgrading.md"), "utf8");
  assert.match(src, /close every app that uses Monomem and stop the server/);
  assert.match(src, /monomem restore \$\{this\.dbPath\}\.pre-v\$\{found\}-backup --yes/);
  assert.match(doc, /close every app that uses Monomem and stop the server, then `monomem restore <database>\.pre-v22-backup --yes`/);
});

test("the time legend says why times are local, what the offset means, and the order", () => {
  assert.match(timeLegend("Newest first"), /local time.*offset from UTC.*Newest first\.$/);
  assert.match(timeLegend("Oldest first"), /Oldest first\.$/);
});
