// Static guard: every `UPDATE notes SET` in src/ is either inside the CAS helper (src/store/cas.ts) or on this reasoned allowlist.
// A new bare statement fails here, which forces a decision: use casUpdate(), or say why it needs no rev guard.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface Allowed {
  file: string;
  /** A fragment that starts the statement text after `UPDATE notes SET `. */
  starts: string;
  reason: string;
}

const A = (file: string, starts: string, reason: string): Allowed => ({ file, starts, reason });
const NO_BUMP = "metadata column outside the content seal; no rev change, no content change";
const ALLOWED: Allowed[] = [
  A("src/store/confirm.ts", "confirmed_at = ?", "confirm: decided inside the write transaction against confirmed_rev; no content change"),
  A("src/store/gates.ts", "pinned = ?", NO_BUMP + " (operator pin)"),
  A("src/store/ledger.ts", "seal = ? WHERE id = ?", "writes only the seal column, inside the transaction that changed the note (flushSeals)"),
  A("src/store/seal.ts", "seal = NULL WHERE id = new.id", "the seal trigger: an edit that did not write a seal leaves it NULL"),
  A("src/store/migrate.ts", "grandfathered_at = ?", "one-off migration step under the upgrade lock"),
  A("src/store/migrate.ts", "content_at = CASE", "one-off migration step under the upgrade lock"),
  A("src/store/quarantine.ts", "approved_at = ?", "approval stamp, written in the same transaction as the CAS-pinned held write"),
  A("src/store/taint.ts", "cli_tty = ?", NO_BUMP),
  A("src/store/taint.ts", "writer_cwd = ?", NO_BUMP),
  A("src/store.ts", "body = ?, body_enc = ? WHERE id = ?", "create(): finishing the row it just inserted inside its own transaction"),
  A("src/store.ts", "access_count = access_count + ?", "volatile read counters; never part of the content"),
  A("src/store.ts", "body_enc = ? WHERE id = ?", "encryption key change: re-wraps the same text under the write lock"),
  A("src/store.ts", "namespace = ?, title = ?", "update(): the rev is re-derived from the row under the write lock (nextRevUnderLock) and an if_rev is in the WHERE"),
  A("src/store.ts", "imported_unverified = 1", "inside update()'s transaction, after its guarded write"),
  A("src/store.ts", "grandfathered_at = NULL WHERE id", "inside update()'s transaction, after its guarded write"),
  A("src/store.ts", "archived_at = ? WHERE expires_at", "expiry sweep: guarded by its own WHERE (expired and not archived); idempotent"),
  A("src/store.ts", "archived_at = ? WHERE ${w.sql}", "bulk archive: idempotent state change guarded by the filter"),
  A("src/store.ts", "archived_at = ? WHERE id = ? AND archived_at IS NULL", "archive: idempotent state change guarded by archived_at IS NULL"),
  A("src/store.ts", "archived_at = NULL, expires_at = ?", "restore: idempotent state change under the write lock"),
  A("src/store.ts", "body_enc = ?, body = '' WHERE id = ?", "encryption enable: re-wraps the same text under the write lock"),
  A("src/store.ts", "body = ?, body_enc = NULL WHERE id = ?", "encryption disable: same text under the write lock"),
  A("src/store.ts", "superseded_by = ?, superseded_at = ?, superseded_by_writer = ? WHERE id = ? AND archived_at", "consolidation link: guarded by archived_at IS NOT NULL AND superseded_by IS NULL"),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("every `UPDATE notes SET` is inside casUpdate or on the reasoned allowlist", () => {
  const root = join(process.cwd(), "src").replace(/[\\/]dist[\\/]/, "/");
  const srcDir = process.cwd().endsWith("dist") ? join(process.cwd(), "..", "src") : root;
  const found: Array<{ file: string; text: string }> = [];
  for (const f of walk(srcDir)) {
    const rel = "src/" + relative(srcDir, f).replace(/\\/g, "/");
    if (rel === "src/store/cas.ts") continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/UPDATE notes SET /g)) found.push({ file: rel, text: src.slice(m.index! + m[0].length, m.index! + m[0].length + 200).replace(/\r/g, "") });
  }
  const used = new Set<Allowed>();
  const bare = found.filter((f) => {
    const hit = ALLOWED.find((a) => a.file === f.file && f.text.replace(/\s+/g, " ").startsWith(a.starts.replace(/\s+/g, " ").trimEnd()));
    if (hit) used.add(hit);
    return !hit;
  });
  assert.deepEqual(bare.map((b) => `${b.file}: UPDATE notes SET ${b.text.slice(0, 60)}`), [], "bare UPDATE notes SET outside casUpdate: use casUpdate() or add it to the allowlist with a reason");
  assert.deepEqual(ALLOWED.filter((a) => !used.has(a)).map((a) => `${a.file}: ${a.starts}`), [], "stale allowlist entries");
});

test("casUpdate refuses a stale rev and leaves the row alone", async () => {
  const { Store } = await import("../src/store.js");
  const { casUpdate } = await import("../src/store/cas.js");
  const s = new Store(":memory:");
  const n = s.create({ title: "t", body: "b" });
  assert.equal(s.transaction(() => casUpdate(s.db, n.id, 1, "title = ?", ["x"])), true);
  assert.throws(() => s.transaction(() => casUpdate(s.db, n.id, 1, "title = ?", ["y"])), /nothing was changed/);
  assert.equal(s.transaction(() => casUpdate(s.db, n.id, 1, "title = ?", ["y"], { soft: true })), false);
  assert.equal(s.read(n.id)?.title, "x");
  assert.equal(s.read(n.id)?.rev, 2);
  s.close();
});
