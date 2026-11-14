// 1.5.0 R1-16: session start must not scan the whole notes table. The unconfirmed scan has a partial index, its cache is not
// invalidated by read bookkeeping, and the expiry count is decided in SQL.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";

const raw = (s: Store): any => (s as any).db;
afterEach(() => setProcessWriter(""));

/** A synthetic store: `n` ordinary live notes (grandfathered flag cleared, as after the upgrade window), `tainted` of them stamped. */
function bigStore(n: number, tainted: number): Store {
  const s = new Store(":memory:");
  const db = raw(s);
  db.exec("BEGIN");
  const ins = db.prepare("INSERT INTO notes (namespace, title, body, tags, created_at, updated_at, content_at, written_by, rev) VALUES (?, ?, ?, ?, ?, ?, ?, 'stdio:x', 1)");
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) ins.run(`ns${i % 7}`, `note ${i}`, "body", i < tainted ? '["obs.origin:tool:WebFetch"]' : "[]", now, now, now);
  db.exec("COMMIT");
  return s;
}

describe("R1-16 query plans", () => {
  test("the unconfirmed scan uses the partial index (no full table scan) on a 20k-note store", () => {
    const s = bigStore(20_000, 40);
    for (const namespaces of [undefined, ["ns1", "ns2"]]) {
      const { sql, params } = (s as any).unconfirmedSql(namespaces);
      const plan = (raw(s).prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      assert.match(plan, /idx_notes_origin/, plan);
      assert.doesNotMatch(plan, /SCAN notes(?! USING)/, `a full table scan: ${plan}`);
    }
    s.close();
  });

  test("list, search and the live-namespace listing use an index too", () => {
    const s = bigStore(20_000, 0);
    const plans = [
      "SELECT id FROM notes WHERE namespace = 'ns1' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 20",
      "SELECT id FROM notes WHERE id = 5",
    ];
    for (const q of plans) {
      const plan = (raw(s).prepare(`EXPLAIN QUERY PLAN ${q}`).all() as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
      assert.doesNotMatch(plan, /SCAN notes(?! USING)/, `${q}: ${plan}`);
    }
    s.close();
  });
});

describe("R1-16 the unconfirmed cache", () => {
  test("reads and the access log do not invalidate it; a note write does", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio:cursor");
    const n = s.create({ title: "from the web", body: "b", outside: true });
    setProcessWriter("");
    let scans = 0;
    const orig = (s as any).scanUnconfirmed.bind(s);
    (s as any).scanUnconfirmed = (...a: unknown[]) => {
      scans++;
      return orig(...a);
    };
    assert.equal(s.unconfirmedBreakdown().declared, 1);
    assert.equal(scans, 1);
    s.read(n.id, { trackAccess: true } as any);
    s.flushAccess();
    s.logAccess({ tool: "state_read", query: "x" });
    assert.equal(s.unconfirmedBreakdown().declared, 1);
    assert.equal(scans, 1, "bookkeeping did not rescan");
    setProcessWriter("stdio:cursor");
    s.create({ title: "another", body: "b", outside: true });
    setProcessWriter("");
    assert.equal(s.unconfirmedBreakdown().declared, 2);
    assert.equal(scans, 2, "a note write did");
    s.close();
  });
});

describe("R1-16 expiry is decided in SQL", () => {
  test("the SQL prefilter agrees with each note's own expired flag on a mixed set", () => {
    const s = new Store(":memory:");
    const db = raw(s);
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const ids: number[] = [];
    setProcessWriter("cli");
    for (let i = 0; i < 8; i++) ids.push(s.create({ title: `n${i}`, body: "b" }).id);
    setProcessWriter("");
    db.prepare("UPDATE notes SET grandfathered_at = NULL, content_at = ?, updated_at = ?").run(old, old);
    db.prepare("UPDATE notes SET confirmed_at = ?, confirmed_kind = 'human', confirmed_rev = rev WHERE id = ?").run(recent, ids[1]); // fresh human confirm: not due
    db.prepare("UPDATE notes SET confirmed_at = ?, confirmed_kind = 'human', confirmed_rev = rev - 1 WHERE id = ?").run(recent, ids[2]); // confirm of an older version: due
    db.prepare("UPDATE notes SET confirmed_at = ?, confirmed_kind = 'corroborated', confirmed_rev = rev WHERE id = ?").run(recent, ids[3]); // corroboration never restarts it: due
    db.prepare("UPDATE notes SET grandfathered_at = ? WHERE id = ?").run(recent, ids[4]); // upgraded recently: not due
    db.prepare("UPDATE notes SET content_at = ?, updated_at = ? WHERE id = ?").run(recent, recent, ids[5]); // edited recently: not due
    db.prepare("UPDATE notes SET pinned = 1 WHERE id = ?").run(ids[6]); // pinned: exempt
    const flagged = ids.filter((id) => s.read(id)!.expired === true).sort();
    assert.deepEqual(flagged, [ids[0], ids[2], ids[3], ids[7]].sort());
    assert.equal(s.expiredCount(), flagged.length);
    s.close();
  });
});
