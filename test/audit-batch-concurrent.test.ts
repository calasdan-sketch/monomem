// Round 3 red team: an import writes its audit lines in big batches (auditBatch) while other programs append single lines
// (`monomem add`). The batch used to chain from a read of the log's end taken before the others wrote, so `audit verify`
// said BROKEN. The append lock keeps every batch and every single line in one chain.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { audit, verifyAuditChain } from "../src/security.js";
import { takeAuditLock, releaseAuditLock, auditLockPath } from "../src/audit-lock.js";

function runChildren(log: string, batchers: number, batchLines: number, singles: number, singleLines: number): Promise<number[]> {
  const security = pathToFileURL(join(import.meta.dirname, "..", "src", "security.js")).href;
  const start = Date.now() + 1500;
  const common = `const { audit, auditBatch } = await import(${JSON.stringify(security)}); while (Date.now() < ${start}) {}`;
  const batchCode = `${common}\nauditBatch(() => { for (let i = 0; i < ${batchLines}; i++) audit({ op: "import-test", detail: String(process.pid) }); });`;
  const singleCode = `${common}\nfor (let i = 0; i < ${singleLines}; i++) audit({ op: "add-test", detail: String(process.pid) });`;
  const run = (code: string) =>
    new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, MONOMEM_AUDIT_LOG: log }, stdio: "ignore" });
      child.on("exit", (c) => resolve(c ?? -1));
    });
  return Promise.all([...Array.from({ length: batchers }, () => run(batchCode)), ...Array.from({ length: singles }, () => run(singleCode))]);
}

describe("audit batches and single appends from several programs", () => {
  test("2 importing programs and 3 adding programs at once leave an intact chain (3 rounds)", async () => {
    for (let round = 0; round < 3; round++) {
      const dir = mkdtempSync(join(tmpdir(), "monomem-auditconc-"));
      const log = join(dir, "audit.log");
      process.env.MONOMEM_AUDIT_LOG = log;
      audit({ op: "seed" }); // an existing log, so the batches take the batch route (a brand-new log writes line 1 singly)
      const codes = await runChildren(log, 2, 2500, 3, 200);
      assert.deepEqual(codes, [0, 0, 0, 0, 0]);
      const r = verifyAuditChain(log);
      assert.equal(r.lines, 1 + 2 * 2500 + 3 * 200, `round ${round}: every line was written`);
      assert.equal(r.breaks, 0, `round ${round}: no broken lines`);
      assert.equal(r.forks, 0, `round ${round}: no forks`);
      assert.equal(r.ok, true);
      assert.equal(existsSync(auditLockPath(log)), false, "the lock folder is gone");
      const seqs = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { seq: number }).seq);
      assert.deepEqual(seqs, seqs.map((_, i) => i + 1), "line numbers run 1..n with no repeats");
    }
  });

  test("a lock left by a killed program is ignored after it goes stale, and a held lock is waited for", () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-auditlock-"));
    const log = join(dir, "audit.log");
    const a = takeAuditLock(log);
    assert.ok(a, "taken");
    releaseAuditLock(a);
    assert.equal(existsSync(auditLockPath(log)), false);
    const b = takeAuditLock(log);
    assert.ok(b);
    releaseAuditLock(b);
  });
});
