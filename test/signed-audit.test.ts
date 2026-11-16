import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// 1.5.0 round 3 item 3: every audit line is Ed25519-signed by the store's own key (.attest-key) over its chain hash, and
// every write receipt (accepted, held, refused) is a signed v2 receipt carrying note id, rev and a content hash that the
// audit log itself never carries. A receipt verifies offline with only the public key (CLI --pubkey, or the standalone
// docs/verify-receipt.mjs). Tamper cases: an edited line, a removed line, a tail cut after a checkpoint, a signature from
// a wrong key, and a key change that only counts through a key-rotate line signed by the old key.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { audit, verifyAuditChain } from "../src/security.js";
import { AUDIT_DOMAIN, ATTEST_KEY_FILENAME, contentHash, ephemeralKey, loadOrCreateSigningKey, peekSigningKey, replaceSigningKey, signBytes, verifyBytes, type SigningKey } from "../src/attest.js";
import { verifyReceipt, type WriteReceipt } from "../src/store/write-receipt.js";
import { PROJECT_ROOT } from "../src/config.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const CHECKER = join(PROJECT_ROOT, "docs", "verify-receipt.mjs");
const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const SIG_TAIL = /,"sig":"([A-Za-z0-9_-]+)"\}$/;

let dir = "";
let db = "";
let log = "";
let stores: Store[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "om-signed-audit-"));
  db = join(dir, "state.db");
  log = join(dir, "audit.log");
  process.env.MONOMEM_AUDIT_LOG = log;
  stores = [];
});
afterEach(() => {
  for (const s of stores) s.close();
  delete process.env.MONOMEM_AUDIT_LOG;
  rmSync(dir, { recursive: true, force: true });
});
const open = (): Store => {
  const s = new Store(db);
  stores.push(s);
  return s;
};
const raw = (): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);
const sha = async (l: string) => (await import("node:crypto")).createHash("sha256").update(l).digest("hex");
const ring = (...ks: SigningKey[]) => Object.fromEntries(ks.map((k) => [k.keyId, k.publicKey]));
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db, MONOMEM_AUDIT_LOG: log } });

/** Rewrite lines from `from` on: fix each `prev`, and re-sign with `key` (or keep the old, now wrong, signature). */
async function rechain(lines: string[], from: number, key?: SigningKey): Promise<string[]> {
  const out = lines.slice(0, from);
  for (let i = from; i < lines.length; i++) {
    const m = SIG_TAIL.exec(lines[i]);
    let body = m ? lines[i].slice(0, m.index) + "}" : lines[i];
    if (i > 0) body = body.replace(/"prev":"[0-9a-f]{64}"/, `"prev":"${await sha(out[i - 1])}"`);
    const sig = key ? signBytes(key, AUDIT_DOMAIN + body) : m?.[1];
    out.push(sig ? body.slice(0, -1) + `,"sig":"${sig}"}` : body);
  }
  return out;
}

describe("signed audit lines", () => {
  test("a note write makes the store key; every line is signed over its body; the content hash is only in the receipt", () => {
    const s = open();
    const n = s.create({ title: "receipt title", body: "the body text", tags: ["b", "a"] });
    const r = s.takeWriteReceipt()!;
    const key = peekSigningKey(dir)!;
    assert.ok(key, "the first audited write created .attest-key beside the database");
    assert.equal(r.v, 2);
    assert.equal(r.decision, "accepted");
    assert.equal(r.note_id, n.id);
    assert.equal(r.rev, n.rev);
    assert.equal(r.content_hash, contentHash("receipt title", "the body text", ["a", "b"]));
    assert.equal(r.key_id, key.keyId);
    assert.equal(r.server_id, s.serverId());
    assert.equal(verifyReceipt(r, key.publicKey), true);
    const lines = raw();
    assert.equal(JSON.parse(lines[0]).op, "sign-start", "the first signed line of a log names the key it starts with");
    for (const l of lines) {
      const m = SIG_TAIL.exec(l)!;
      assert.ok(m, "signed");
      assert.equal(JSON.parse(l).kid, key.keyId);
      assert.equal(verifyBytes(key.publicKey, AUDIT_DOMAIN + l.slice(0, m.index) + "}", m[1]), true);
    }
    const text = readFileSync(log, "utf8");
    assert.ok(!text.includes(r.content_hash!), "the audit log never carries anything derived from note text");
    assert.ok(!text.includes("the body text") && !text.includes("receipt title"));
    const v = verifyAuditChain(log, undefined, { keys: ring(key), allSignatures: true });
    assert.equal(v.ok, true);
    assert.equal(v.signed, lines.length);
    assert.equal(v.bad_signature, 0);
    assert.equal(v.head_key_trusted, true);
  });

  test("no key file: lines stay unsigned and no key is created (audit never mints one)", () => {
    for (let i = 0; i < 3; i++) audit({ op: "noop", detail: String(i) });
    assert.ok(!existsSync(join(dir, ATTEST_KEY_FILENAME)));
    for (const l of raw()) assert.ok(!SIG_TAIL.test(l));
    const v = verifyAuditChain(log);
    assert.equal(v.ok, true);
    assert.equal(v.signed, 0);
    assert.equal(v.unsigned_before_signing, 3);
  });

  test("migration: 50 unsigned lines, then a key: a signed sign-start line freezes them", async () => {
    for (let i = 0; i < 50; i++) audit({ op: "noop" });
    const head = await sha(raw()[49]);
    const key = loadOrCreateSigningKey(dir);
    audit({ op: "after" });
    const lines = raw();
    const start = JSON.parse(lines[50]);
    assert.equal(start.op, "sign-start");
    assert.equal(start.prev, head);
    assert.equal(start.detail, `50 unsigned lines before; head ${head}`);
    assert.equal(start.pub, key.publicKey);
    const v = verifyAuditChain(log, undefined, { keys: ring(key) });
    assert.equal(v.ok, true);
    assert.equal(v.unsigned_before_signing, 50);
    assert.equal(v.unsigned_after_signing, 0);
    assert.equal(v.signed, 2);
  });
});

describe("tamper", () => {
  async function seeded(): Promise<{ key: SigningKey; receipt: WriteReceipt }> {
    const s = open();
    s.create({ title: "one", body: "a" });
    const receipt = (s.create({ title: "two", body: "b" }), s.takeWriteReceipt()!);
    s.create({ title: "three", body: "c" });
    s.create({ title: "four", body: "d" });
    return { key: peekSigningKey(dir)!, receipt };
  }

  test("an edited line breaks the chain; a removed line breaks it too", async () => {
    const { key } = await seeded();
    const lines = raw();
    writeFileSync(log, lines.map((l, i) => (i === 2 ? l.replace(/"bytes":\d+/, '"bytes":999') : l)).join("\n") + "\n");
    assert.equal(verifyAuditChain(log, undefined, { keys: ring(key) }).ok, false);
    writeFileSync(log, lines.filter((_, i) => i !== 2).join("\n") + "\n");
    assert.equal(verifyAuditChain(log, undefined, { keys: ring(key) }).ok, false);
  });

  test("rewriting every line after an edit without the key: the newest signature fails", async () => {
    const { key } = await seeded();
    const lines = raw();
    lines[2] = lines[2].replace(/"bytes":\d+/, '"bytes":999');
    writeFileSync(log, (await rechain(lines, 3)).join("\n") + "\n");
    const v = verifyAuditChain(log, undefined, { keys: ring(key) });
    assert.equal(v.breaks, 0, "the hash chain itself is consistent again");
    assert.ok(v.bad_signature >= 1);
    assert.equal(v.ok, false);
  });

  test("rewriting WITH the key passes audit verify, but an earlier receipt no longer verifies (the honest limit)", async () => {
    const { key, receipt } = await seeded();
    const lines = raw();
    lines[1] = lines[1].replace(/"bytes":\d+/, '"bytes":999');
    writeFileSync(log, (await rechain(lines, 1, key)).join("\n") + "\n");
    assert.equal(verifyAuditChain(log, undefined, { keys: ring(key), allSignatures: true }).ok, true);
    const rf = join(dir, "r.json");
    writeFileSync(rf, JSON.stringify(receipt));
    const r = cli("verify-receipt", "--file", rf);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /NOT verified/);
  });

  test("a tail cut after a checkpoint: audit verify alone passes (documented limit), --checkpoint fails", () => {
    const s = open();
    for (let i = 0; i < 4; i++) s.create({ title: `n${i}`, body: "x" });
    const out = join(dir, "cp.json");
    const cp = cli("audit", "checkpoint", "--out", out);
    assert.equal(cp.status, 0, cp.stderr);
    const c = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(c.decision, "checkpoint");
    assert.equal(c.chain_hash, verifyAuditChain(log).head);
    assert.equal(cli("audit", "verify", "--checkpoint", out).status, 0);
    writeFileSync(log, raw().slice(0, -2).join("\n") + "\n");
    const plain = cli("audit", "verify");
    assert.equal(plain.status, 0, plain.stderr);
    const anchored = cli("audit", "verify", "--checkpoint", out);
    assert.equal(anchored.status, 1);
    assert.match(anchored.stderr, /NOT FOUND/);
  });

  test("a signature from a wrong key: an untrusted head fails; a line signed by another key mid-chain is a bad signature", async () => {
    const { key } = await seeded();
    const other = ephemeralKey();
    const v1 = verifyAuditChain(log, undefined, { keys: ring(other) });
    assert.equal(v1.head_key_trusted, false);
    assert.equal(v1.ok, false);
    // A line appended with a correct prev, signed by a key the log never handed over to.
    const lines = raw();
    const body = JSON.stringify({ ts: new Date().toISOString(), prev: await sha(lines[lines.length - 1]), seq: 99, op: "forged", kid: other.keyId });
    writeFileSync(log, [...lines, body.slice(0, -1) + `,"sig":"${signBytes(other, AUDIT_DOMAIN + body)}"}`].join("\n") + "\n");
    const v2 = verifyAuditChain(log, undefined, { keys: ring(key, other) });
    assert.equal(v2.breaks, 0);
    assert.equal(v2.bad_signature, 1);
    assert.equal(v2.ok, false);
  });
});

describe("key rotation", () => {
  test("trust rotate writes a key-rotate line signed by the old key; old and new receipts verify with their own key", () => {
    const s = open();
    s.create({ title: "before", body: "x" });
    const r1 = s.takeWriteReceipt()!;
    const old = peekSigningKey(dir)!;
    s.rotateSigningKey();
    const now = peekSigningKey(dir)!;
    assert.notEqual(now.keyId, old.keyId);
    s.create({ title: "after", body: "y" });
    const r2 = s.takeWriteReceipt()!;
    const recs = raw().map((l) => JSON.parse(l));
    const rot = recs.findIndex((r) => r.op === "key-rotate");
    assert.ok(rot > 0);
    assert.equal(recs[rot].kid, old.keyId, "signed by the old key");
    assert.equal(recs[rot].new_pub, now.publicKey);
    for (const r of recs.slice(rot + 1)) assert.equal(r.kid, now.keyId);
    assert.equal(verifyAuditChain(log, undefined, { keys: ring(now), allSignatures: true }).ok, true);
    assert.equal(verifyReceipt(r1, old.publicKey), true);
    assert.equal(verifyReceipt(r2, now.publicKey), true);
    assert.equal(verifyReceipt(r2, old.publicKey), false);
  });

  test("a key swapped without a key-rotate line is not accepted; a line signed by the retired key after rotation is a bad signature", async () => {
    const s = open();
    s.create({ title: "a", body: "x" });
    const old = peekSigningKey(dir)!;
    replaceSigningKey(dir); // behind the store's back: no key-rotate line
    s.create({ title: "b", body: "y" });
    const v = verifyAuditChain(log, undefined, { keys: ring(old, peekSigningKey(dir)!) });
    assert.ok(v.bad_signature >= 1);
    assert.equal(v.ok, false);

    rmSync(log);
    const s2 = open();
    s2.create({ title: "c", body: "x" });
    const before = peekSigningKey(dir)!;
    s2.rotateSigningKey();
    s2.create({ title: "d", body: "y" });
    const lines = raw();
    const body = JSON.stringify({ ts: new Date().toISOString(), prev: await sha(lines[lines.length - 1]), seq: 99, op: "late", kid: before.keyId });
    writeFileSync(log, [...lines, body.slice(0, -1) + `,"sig":"${signBytes(before, AUDIT_DOMAIN + body)}"}`].join("\n") + "\n");
    const v2 = verifyAuditChain(log, undefined, { keys: ring(before, peekSigningKey(dir)!) });
    assert.equal(v2.bad_signature, 1);
    assert.equal(v2.ok, false);
  });
});

describe("signed receipts", () => {
  async function mcpWorld(s: Store) {
    const server = createMcpServer(s, "write", {}, { label: "mcp-writer", authed: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "signed", version: "1" });
    await Promise.all([client.connect(a), server.connect(b)]);
    const write = async (args: Record<string, unknown>) => {
      const r = (await client.callTool({ name: "state_write", arguments: args })) as { content: Array<{ text: string }> };
      const t = r.content[0].text;
      return JSON.parse(t.slice(t.indexOf("{"))).receipt as WriteReceipt;
    };
    return { write, close: () => client.close() };
  }

  test("held and refused writes get signed receipts; the refused one has no content hash", async () => {
    const s = open();
    s.setApproveFirst("held", true);
    const w = await mcpWorld(s);
    try {
      const held = await w.write({ namespace: "held", title: "needs approval", body: "x" });
      const refused = await w.write({ title: "leak", body: `token ${SECRET}` });
      const key = peekSigningKey(dir)!;
      assert.equal(held.decision, "held");
      assert.equal(held.content_hash, contentHash("needs approval", "x", []));
      assert.equal(verifyReceipt(held, key.publicKey), true);
      assert.equal(refused.decision, "refused");
      assert.equal(refused.content_hash, undefined);
      assert.equal(verifyReceipt(refused, key.publicKey), true);
      assert.ok(!readFileSync(log, "utf8").includes(held.content_hash!));
    } finally {
      await w.close();
    }
  });

  test("verify-receipt --file --pubkey works offline (base64 or a file); one changed field fails; the limits are printed", () => {
    const s = open();
    s.create({ title: "offline", body: "x" });
    const r = s.takeWriteReceipt()!;
    const key = peekSigningKey(dir)!;
    const rf = join(dir, "r.json");
    const pf = join(dir, "pub.txt");
    writeFileSync(rf, JSON.stringify(r));
    writeFileSync(pf, key.publicKey + "\n");
    // No store: a different home and database path that do not exist.
    const offline = (...a: string[]) => spawnSync(process.execPath, [CLI, "verify-receipt", ...a], { encoding: "utf8", env: { ...process.env, MONOMEM_HOME: join(dir, "nowhere"), MONOMEM_DB_PATH: join(dir, "nowhere", "x.db") } });
    for (const pk of [key.publicKey, pf]) {
      const ok = offline("--file", rf, "--pubkey", pk);
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /Signature OK/);
      assert.match(ok.stdout, new RegExp(`accepted note #${r.note_id} rev ${r.rev}`));
      assert.match(ok.stdout, /does not prove/i);
    }
    assert.ok(!existsSync(join(dir, "nowhere", "x.db")) && !existsSync(join(dir, "nowhere", ATTEST_KEY_FILENAME)), "offline checking opened no store");
    for (const field of ["seq", "chain_hash", "decision", "ts", "server_id", "note_id", "rev", "content_hash"] as const) {
      const t = { ...r } as Record<string, unknown>;
      const v = t[field];
      t[field] = typeof v === "number" ? v + 1 : String(v).replace(/^./, (c) => (c === "a" ? "b" : "a"));
      writeFileSync(rf, JSON.stringify(t));
      assert.equal(offline("--file", rf, "--pubkey", key.publicKey).status, 1, `changed ${field}`);
    }
    writeFileSync(rf, JSON.stringify(r));
    assert.equal(offline("--file", rf, "--pubkey", ephemeralKey().publicKey).status, 1, "wrong key");
  });

  test("--note: unchanged since the receipt, then changed later (rev N)", () => {
    const s = open();
    const n = s.create({ title: "watched", body: "first" });
    const r = s.takeWriteReceipt()!;
    const rf = join(dir, "r.json");
    writeFileSync(rf, JSON.stringify(r));
    const a = cli("verify-receipt", "--file", rf, "--note", String(n.id));
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /unchanged since/);
    const upd = s.update(n.id, { body: "second" })!;
    const b = cli("verify-receipt", "--file", rf, "--note", String(n.id));
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, new RegExp(`changed later \\(rev ${upd.rev}\\)`));
  });

  test("docs/verify-receipt.mjs (plain node:crypto, no Monomem) checks a receipt and a checkpoint", () => {
    const s = open();
    s.create({ title: "standalone", body: "x" });
    const r = s.takeWriteReceipt()!;
    const key = peekSigningKey(dir)!;
    const rf = join(dir, "r.json");
    writeFileSync(rf, JSON.stringify(r));
    const run = () => spawnSync(process.execPath, [CHECKER, rf, key.publicKey], { encoding: "utf8", cwd: dir, env: { PATH: process.env.PATH ?? "" } });
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /valid/);
    writeFileSync(rf, JSON.stringify({ ...r, rev: (r.rev ?? 0) + 1 }));
    assert.equal(run().status, 1);
    const cp = cli("audit", "checkpoint", "--out", rf);
    assert.equal(cp.status, 0, cp.stderr);
    assert.equal(run().status, 0);
  });

  test("performance: signing adds well under a millisecond per audited line (p50)", () => {
    const p50 = (n: number) => {
      const t: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = performance.now();
        audit({ op: "bench" });
        t.push(performance.now() - a);
      }
      return t.sort((x, y) => x - y)[n >> 1];
    };
    const plain = p50(300);
    loadOrCreateSigningKey(dir);
    const signed = p50(300);
    assert.ok(signed - plain < 0.5, `signed ${signed.toFixed(3)} ms vs unsigned ${plain.toFixed(3)} ms`);
  });
});
