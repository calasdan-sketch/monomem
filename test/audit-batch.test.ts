// Round 3: audit lines written inside auditBatch() reach the log in one open and one write, and the chain is the same
// chain: verifiable, in order, with the real seq and hash handed back to each caller. A 20,000-note import used to open,
// stat and close audit.log once per note.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, auditBatch, auditHead, verifyAuditChain } from "../src/security.js";
import { Store } from "../src/store.js";

function withLog<T>(fn: (log: string, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "om-audbatch-"));
  const save = process.env.MONOMEM_AUDIT_LOG;
  process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log");
  try {
    return fn(process.env.MONOMEM_AUDIT_LOG, dir);
  } finally {
    if (save === undefined) delete process.env.MONOMEM_AUDIT_LOG;
    else process.env.MONOMEM_AUDIT_LOG = save;
    rmSync(dir, { recursive: true, force: true });
  }
}
const countOpens = <T>(fn: () => T): { out: T; opens: number } => {
  const real = fs.openSync;
  let opens = 0;
  fs.openSync = ((...a: Parameters<typeof fs.openSync>) => (opens++, real(...a))) as typeof fs.openSync;
  syncBuiltinESMExports();
  try {
    return { out: fn(), opens };
  } finally {
    fs.openSync = real;
    syncBuiltinESMExports();
  }
};

test("300 audit lines in one batch: a handful of opens, a verifiable chain, the returned hashes are the lines' hashes", () =>
  withLog((log) => {
    audit({ op: "first" }); // the first line of a new log is written the ordinary way
    const results: Array<ReturnType<typeof audit>> = [];
    const { opens } = countOpens(() => auditBatch(() => { for (let i = 0; i < 300; i++) results.push(audit({ op: "t", id: i })); }));
    assert.ok(opens <= 8, `openSync ran ${opens} times for 300 batched lines`);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(lines.length, 301);
    const r = verifyAuditChain(log);
    assert.equal(r.ok, true);
    assert.equal(r.forks, 0);
    assert.equal(r.breaks, 0);
    results.forEach((x, i) => {
      assert.equal(x?.seq, i + 2);
      assert.equal(x?.chain_hash, createHash("sha256").update(lines[i + 1]).digest("hex"));
    });
  }));

test("lines after a batch continue the same chain; a head read inside a batch sees the buffered lines", () =>
  withLog((log) => {
    audit({ op: "a" });
    auditBatch(() => {
      audit({ op: "b" });
      audit({ op: "c" });
      assert.equal(auditHead()?.seq, 3, "auditHead flushes first");
      audit({ op: "d" });
    });
    audit({ op: "e" });
    const r = verifyAuditChain(log);
    assert.equal(r.ok, true);
    assert.equal(r.lines, 5);
    assert.equal(r.forks, 0);
  }));

test("a batch that throws still writes the lines made so far, and nested batches write once", () =>
  withLog((log) => {
    audit({ op: "a" });
    assert.throws(() => auditBatch(() => { audit({ op: "b" }); auditBatch(() => audit({ op: "c" })); throw new Error("boom"); }), /boom/);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
    assert.equal(verifyAuditChain(log).ok, true);
  }));

test("importing more than one batch of notes keeps the audit chain intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "om-audbatch-"));
  const log = join(dir, "audit.log");
  const save = process.env.MONOMEM_AUDIT_LOG;
  process.env.MONOMEM_AUDIT_LOG = log;
  try {
    const store = new Store(join(dir, "state.db"), { auditLog: log });
    try {
      const notes = Array.from({ length: 1100 }, (_, i) => ({ namespace: "default", title: `Imported ${i}`, body: `Body ${i} about topic ${i % 7}`, tags: ["t"] }));
      const made = await store.importNotes(notes, { deferEdges: true, dedupe: false });
      assert.equal(made.length, 1100);
    } finally {
      store.close();
    }
    const lines = readFileSync(log, "utf8").trim().split("\n").length;
    assert.ok(lines >= 1100, `${lines} audit lines for 1100 notes`);
    const r = verifyAuditChain(log);
    assert.equal(r.ok, true);
    assert.equal(r.forks, 0);
    assert.equal(r.breaks, 0);
  } finally {
    if (save === undefined) delete process.env.MONOMEM_AUDIT_LOG;
    else process.env.MONOMEM_AUDIT_LOG = save;
    rmSync(dir, { recursive: true, force: true });
  }
});
