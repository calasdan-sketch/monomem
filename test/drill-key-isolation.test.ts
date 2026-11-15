// Final panel round 2, ease-of-use B1: `drill` (and `health`, which runs it) opened the copy while the audit log path still
// pointed at the real data folder, so the copy's throwaway signing key was mirrored over the real .attest-key and the real
// audit log then failed `audit verify`. The real key, the real log and its verification must be untouched by a drill.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DB_PATH } from "../src/config.js";
import { Store } from "../src/store.js";
import { runDrill } from "../src/drill.js";
import { attestKeyPath } from "../src/attest.js";
import { verifyAuditChain, auditPath } from "../src/security.js";

test("a drill leaves the real signing key, the real audit log and its verification as they were", async () => {
  const s = new Store(DB_PATH);
  s.create({ title: "before", body: "a note written before the drill" });
  s.close();
  const keyFile = attestKeyPath(DATA_DIR);
  assert.ok(existsSync(keyFile), "the first write made the signing key");
  const keyBefore = readFileSync(keyFile);
  const logBefore = readFileSync(auditPath(), "utf8");
  assert.equal(verifyAuditChain().ok, true);

  const errs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    await runDrill({ dbPath: DB_PATH });
  } finally {
    console.error = orig;
  }

  assert.ok(readFileSync(keyFile).equals(keyBefore), "the real .attest-key is unchanged");
  assert.equal(readFileSync(auditPath(), "utf8"), logBefore, "the drill appended nothing to the real audit log");
  assert.ok(!errs.some((e) => /NEW attestation key/i.test(e)), `no new-key warning: ${errs.join(" | ")}`);
  assert.equal(process.env.MONOMEM_AUDIT_LOG, undefined, "the audit log override is restored");

  const s2 = new Store(DB_PATH);
  s2.create({ title: "after", body: "a note written after the drill" });
  s2.close();
  const v = verifyAuditChain(auditPath(), undefined, { strict: true });
  assert.equal(v.ok, true, `audit verify after the drill: ${JSON.stringify(v)}`);
  assert.ok(join(DATA_DIR, "audit.log") === auditPath());
});
