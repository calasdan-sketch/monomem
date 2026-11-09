// Every state change is audited, and the audit log is a hash chain (`prev`) that `audit verify` walks.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { audit, auditPath, verifyAuditChain } from "../src/security.js";

describe("in-memory store and the audit log", () => {
  test("a Store(':memory:') with no audit path configured writes no audit.log", () => {
    const home = mkdtempSync(join(tmpdir(), "monomem-audit-mem-"));
    const saveHome = process.env.MONOMEM_HOME;
    const saveLog = process.env.MONOMEM_AUDIT_LOG;
    delete process.env.MONOMEM_AUDIT_LOG;
    process.env.MONOMEM_HOME = home; // advisory: DATA_DIR is fixed at import, so also assert via the explicit path below
    try {
      const s = new Store(":memory:");
      s.create({ title: "a", body: "alpha" });
      s.setApproveFirst("x", true);
      s.close();
      assert.equal(existsSync(join(home, "audit.log")), false);
      assert.equal(existsSync(auditPath()), false, "nor the default path this process resolves");
      // An explicit path is still honoured.
      const log = join(home, "explicit.log");
      process.env.MONOMEM_AUDIT_LOG = log;
      const s2 = new Store(":memory:");
      s2.create({ title: "b", body: "beta" });
      s2.close();
      assert.equal(existsSync(log), true);
    } finally {
      if (saveHome === undefined) delete process.env.MONOMEM_HOME; else process.env.MONOMEM_HOME = saveHome;
      if (saveLog === undefined) delete process.env.MONOMEM_AUDIT_LOG; else process.env.MONOMEM_AUDIT_LOG = saveLog;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a pinned MONOMEM_DB_PATH puts the audit log beside that database, never in the default data folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-audit-pin-"));
    const saveDb = process.env.MONOMEM_DB_PATH;
    const saveLog = process.env.MONOMEM_AUDIT_LOG;
    delete process.env.MONOMEM_AUDIT_LOG;
    const def = auditPath();
    const before = existsSync(def) ? readFileSync(def, "utf8") : null;
    try {
      const db = join(dir, "state.db");
      process.env.MONOMEM_DB_PATH = db;
      assert.equal(auditPath(), join(dir, "audit.log"));
      const s = new Store(db);
      s.create({ title: "c", body: "gamma" });
      s.close();
      assert.equal(existsSync(join(dir, "audit.log")), true);
      process.env.MONOMEM_DB_PATH = ":memory:";
      assert.equal(auditPath(), def, ":memory: keeps the default rule");
      assert.equal(existsSync(def) ? readFileSync(def, "utf8") : null, before, "the default audit.log is untouched");
    } finally {
      if (saveDb === undefined) delete process.env.MONOMEM_DB_PATH; else process.env.MONOMEM_DB_PATH = saveDb;
      if (saveLog === undefined) delete process.env.MONOMEM_AUDIT_LOG; else process.env.MONOMEM_AUDIT_LOG = saveLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("audit completeness and chain", () => {
  let dir: string;
  let log: string;
  const SAVE = process.env.MONOMEM_AUDIT_LOG;
  const lines = (): any[] => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "monomem-audit-c-"));
    log = join(dir, "audit.log");
    process.env.MONOMEM_AUDIT_LOG = log;
  });
  after(() => {
    if (SAVE === undefined) delete process.env.MONOMEM_AUDIT_LOG;
    else process.env.MONOMEM_AUDIT_LOG = SAVE;
    rmSync(dir, { recursive: true, force: true });
  });

  test("archive, restore and TTL sweep each write an audit line", () => {
    const s = new Store(":memory:");
    const a = s.create({ title: "a", body: "alpha" });
    s.archive(a.id);
    s.restore(a.id);
    s.create({ title: "b", body: "beta", forget_after: 1 });
    assert.equal(s.sweepExpired(Date.now() + 2 * 86_400_000), 1);
    const ops = lines().map((l) => `${l.op}:${l.id ?? ""}`);
    assert.ok(ops.includes(`archive:${a.id}`), ops.join());
    assert.ok(ops.includes(`restore:${a.id}`), ops.join());
    assert.ok(ops.some((o) => o.startsWith("sweep-expire")), ops.join());
  });

  test("each line carries prev = sha256 of the previous line; verify passes", () => {
    audit({ op: "x1" });
    audit({ op: "x2" });
    assert.equal(verifyAuditChain().ok, true);
    assert.ok(lines().every((l) => typeof l.prev === "string"));
  });

  test("the chain continues across a rotation", () => {
    renameSync(log, `${log}.1`);
    audit({ op: "after-rotation" });
    assert.equal(lines().length, 1);
    assert.equal(verifyAuditChain().ok, true);
    assert.equal(lines()[0].prev, createHash("sha256").update(readFileSync(`${log}.1`, "utf8").trim().split("\n").pop()!).digest("hex"));
    renameSync(`${log}.1`, `${log}.tmp`);
    writeFileSync(log, readFileSync(`${log}.tmp`, "utf8") + readFileSync(log, "utf8"));
    rmSync(`${log}.tmp`);
  });

  test("two writers racing (prev names an earlier line) is a fork, not a break", () => {
    audit({ op: "r1" });
    audit({ op: "r2" });
    const all = readFileSync(log, "utf8").trim().split("\n");
    // the last line claims the line BEFORE its predecessor, as when two processes read the same last hash
    const forked = JSON.parse(all[all.length - 1]);
    forked.prev = createHash("sha256").update(all[all.length - 3]).digest("hex");
    all[all.length - 1] = JSON.stringify(forked);
    writeFileSync(log, all.join("\n") + "\n");
    const r = verifyAuditChain();
    assert.equal(r.ok, true);
    assert.equal(r.forks, 1);
    audit({ op: "r3" });
    assert.equal(verifyAuditChain().ok, true, "the chain keeps going after a fork");
  });

  test("a line without prev after the chain started is a break", () => {
    audit({ op: "u1" });
    const all = readFileSync(log, "utf8").trim().split("\n");
    all.splice(all.length - 1, 0, JSON.stringify({ ts: new Date().toISOString(), op: "forged" }));
    writeFileSync(log, all.join("\n") + "\n");
    const r = verifyAuditChain();
    assert.equal(r.ok, false);
    writeFileSync(log, "");
    audit({ op: "u2" });
  });

  test("deleting a middle line is a break", () => {
    audit({ op: "d1" });
    audit({ op: "d2" });
    audit({ op: "d3" });
    const all = readFileSync(log, "utf8").trim().split("\n");
    all.splice(all.length - 2, 1);
    writeFileSync(log, all.join("\n") + "\n");
    const r = verifyAuditChain();
    assert.equal(r.ok, false);
    assert.equal(r.breaks, 1);
    // repair for the next test: rebuild a clean file
    writeFileSync(log, "");
    audit({ op: "e1" });
    audit({ op: "e2" });
    audit({ op: "e3" });
  });

  test("editing a middle line is reported at the line after it", () => {
    const all = readFileSync(log, "utf8").trim().split("\n");
    const i = all.length - 2;
    all[i] = all[i].replace(/"op":"[^"]*"/, '"op":"forged"');
    writeFileSync(log, all.join("\n") + "\n");
    const r = verifyAuditChain();
    assert.equal(r.ok, false);
    assert.equal(r.brokenLine, i + 2);
  });
});
