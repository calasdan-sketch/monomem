// 1.5.0 (round 2, F-03): audit() no longer re-reads the log tail per line; the chain is the same, also with a second process.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { audit, verifyAuditChain } from "../src/security.js";

const securityUrl = pathToFileURL(join(import.meta.dirname, "..", "src", "security.js")).href;

function withLog<T>(fn: (log: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "om-audf03-"));
  const save = process.env.MONOMEM_AUDIT_LOG;
  process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log");
  try {
    return fn(process.env.MONOMEM_AUDIT_LOG);
  } finally {
    if (save === undefined) delete process.env.MONOMEM_AUDIT_LOG;
    else process.env.MONOMEM_AUDIT_LOG = save;
    rmSync(dir, { recursive: true, force: true });
  }
}

const childAudit = (log: string, op: string): void => {
  execFileSync(process.execPath, ["--input-type=module", "-e", `const { audit } = await import(${JSON.stringify(securityUrl)}); audit({ op: ${JSON.stringify(op)} });`], {
    env: { ...process.env, MONOMEM_AUDIT_LOG: log },
  });
};

test("F-03 200 audit() calls open the log at most once per line, and the chain verifies", () =>
  withLog((log) => {
    const realOpen = fs.openSync;
    let opens = 0;
    fs.openSync = ((...a: Parameters<typeof fs.openSync>) => (opens++, realOpen(...a))) as typeof fs.openSync;
    syncBuiltinESMExports();
    try {
      for (let i = 0; i < 200; i++) audit({ op: "t", id: i });
    } finally {
      fs.openSync = realOpen;
      syncBuiltinESMExports();
    }
    assert.ok(opens <= 205, `openSync ran ${opens} times for 200 lines`);
    const r = verifyAuditChain(log);
    assert.equal(r.ok, true);
    assert.equal(r.lines, 200);
    assert.equal(r.forks, 0);
    assert.equal(r.breaks, 0);
  }));

test("F-03 a line another process appended in between is chained on, not forked", () =>
  withLog((log) => {
    audit({ op: "a1" });
    audit({ op: "a2" });
    childAudit(log, "other-process");
    audit({ op: "a3" });
    childAudit(log, "other-process-2");
    childAudit(log, "other-process-3");
    audit({ op: "a4" });
    const r = verifyAuditChain(log);
    assert.equal(r.ok, true);
    assert.equal(r.lines, 7);
    assert.equal(r.forks, 0, "every line names the line before it");
    assert.equal(r.breaks, 0);
  }));

test("F-03 the log was truncated or replaced under us: the next line re-reads the tail", () =>
  withLog((log) => {
    audit({ op: "a1" });
    audit({ op: "a2" });
    const first = readFileSync(log, "utf8").split("\n")[0] + "\n";
    writeFileSync(log, first); // shorter file: cached size no longer matches
    audit({ op: "a3" });
    const r = verifyAuditChain(log);
    assert.equal(r.ok, true);
    assert.equal(r.lines, 2);
  }));
