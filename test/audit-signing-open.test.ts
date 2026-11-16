import "./setup-env.js";
// 1.5.0 round 3 polish, item 1: the store key exists from the moment a store is opened (not from its first write), a log
// placed elsewhere with MONOMEM_AUDIT_LOG is signed by the same key, an in-memory store's lines are unsigned, and a key
// rotation racing other writers never leaves a line signed by the retired key after the key-rotate line.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { verifyAuditChain } from "../src/security.js";
import { ATTEST_KEY_FILENAME, peekSigningKey } from "../src/attest.js";
import { PROJECT_ROOT } from "../src/config.js";

const SIG_TAIL = /,"sig":"([A-Za-z0-9_-]+)"\}$/;
let dir = "";
let logDir = "";
let stores: Store[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "om-sign-open-"));
  logDir = mkdtempSync(join(tmpdir(), "om-sign-log-"));
  stores = [];
});
afterEach(() => {
  for (const s of stores) s.close();
  delete process.env.MONOMEM_AUDIT_LOG;
  rmSync(dir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});
const open = (db: string): Store => {
  const s = new Store(db);
  stores.push(s);
  return s;
};

describe("signing key at store open", () => {
  test("opening a file store makes the key before any write", () => {
    process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log");
    open(join(dir, "state.db"));
    assert.ok(existsSync(join(dir, ATTEST_KEY_FILENAME)), "key exists after open, with no write yet");
  });

  test("a log elsewhere (MONOMEM_AUDIT_LOG) is signed by the same key, kept beside that log", () => {
    const log = join(logDir, "audit.log");
    process.env.MONOMEM_AUDIT_LOG = log;
    const s = open(join(dir, "state.db"));
    s.create({ title: "t", body: "b" });
    const storeKey = peekSigningKey(dir)!;
    const logKey = peekSigningKey(logDir);
    assert.ok(logKey, "a key sits beside the log");
    assert.equal(logKey!.keyId, storeKey.keyId, "the same identity as the store");
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    for (const l of lines) assert.ok(SIG_TAIL.test(l), "every line signed");
    assert.equal(verifyAuditChain(log, undefined, { keys: { [storeKey.keyId]: storeKey.publicKey } }).bad_signature, 0);
    // rotation hands the log over too
    s.rotateSigningKey();
    s.create({ title: "t2", body: "b2" });
    const now = peekSigningKey(dir)!;
    assert.equal(peekSigningKey(logDir)!.keyId, now.keyId, "the copy beside the log follows the rotation");
    const v = verifyAuditChain(log, undefined, { keys: { [now.keyId]: now.publicKey }, allSignatures: true });
    assert.equal(v.ok, true);
    assert.equal(v.bad_signature, 0);
  });

  test("an in-memory store's audit lines are unsigned (documented)", () => {
    const log = join(logDir, "audit.log");
    process.env.MONOMEM_AUDIT_LOG = log;
    const s = open(":memory:");
    s.create({ title: "t", body: "b" });
    const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    for (const l of lines) assert.ok(!SIG_TAIL.test(l));
    assert.ok(!existsSync(join(logDir, ATTEST_KEY_FILENAME)));
  });
});

describe("key rotation with concurrent writers", () => {
  test("lines written by another process during rotations never end up signed by a retired key", async () => {
    const log = join(dir, "audit.log");
    process.env.MONOMEM_AUDIT_LOG = log;
    const s = open(join(dir, "state.db"));
    const script = `
      const { audit } = await import(${JSON.stringify(new URL("../src/security.js", import.meta.url).href)});
      const end = Date.now() + 2500;
      while (Date.now() < end) audit({ op: "noop" });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, MONOMEM_AUDIT_LOG: log }, cwd: PROJECT_ROOT, stdio: "inherit" });
    const done = new Promise<void>((res) => child.on("exit", () => res()));
    for (let i = 0; i < 6; i++) {
      s.rotateSigningKey();
      await new Promise((r) => setTimeout(r, 150));
    }
    await done;
    const now = peekSigningKey(dir)!;
    const v = verifyAuditChain(log, undefined, { keys: { [now.keyId]: now.publicKey }, allSignatures: true });
    assert.equal(v.bad_signature, 0, `bad signature first at line ${v.badSignatureLine}`);
    assert.equal(v.unsigned_after_signing, 0);
  });
});
