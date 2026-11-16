// 1.5.0 (round 2, P2): the scan for pre-1.2.1 (v1) ciphertext runs once per database, not on every open.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey, encrypt } from "../src/crypto.js";

const meta = (s: Store, k: string) => (s.captureDb().prepare("SELECT value FROM _meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;

test("P2 v1 envelopes are upgraded once and the store remembers it was checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-p2-"));
  let s: Store | null = null;
  try {
    const key = ensureKey(dir);
    const path = join(dir, "state.db");
    s = new Store(path);
    const n = s.create({ title: "old", body: "legacy secret" });
    assert.equal(meta(s, "v1_envelopes_checked"), "1", "a new encrypted store is marked checked");
    // Simulate an old v1 envelope and a database from before the flag existed.
    s.captureDb().prepare("UPDATE notes SET body_enc = ? WHERE id = ?").run(encrypt("legacy secret", key), n.id);
    s.captureDb().prepare("DELETE FROM _meta WHERE key = 'v1_envelopes_checked'").run();
    assert.match(String((s.captureDb().prepare("SELECT body_enc FROM notes WHERE id = ?").get(n.id) as { body_enc: string }).body_enc), /^v1:/);
    s.close();
    s = new Store(path);
    assert.match(String((s.captureDb().prepare("SELECT body_enc FROM notes WHERE id = ?").get(n.id) as { body_enc: string }).body_enc), /^v2:/, "upgraded to v2");
    assert.equal(s.read(n.id)!.body, "legacy secret");
    assert.equal(meta(s, "v1_envelopes_checked"), "1");
  } finally {
    s?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
