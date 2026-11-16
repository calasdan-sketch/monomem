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

/** The SQL text of every notes query `fn` prepares, EXPLAINed. */
function plansOf(s: Store, fn: () => unknown): string[] {
  const db = raw(s);
  const seen: string[] = [];
  const orig = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (/FROM notes\b|JOIN notes n\b/.test(sql) &&!/^\s*EXPLAIN/.test(sql)) seen.push(sql);
    return orig(sql);
  };
  try {
    fn();
  } finally {
    db.prepare = orig;
  }
  return seen.map((q) => {
    const n = (q.match(/\?/g) ?? []).length;
    return (orig(`EXPLAIN QUERY PLAN ${q}`).all(...Array(n).fill("x")) as Array<{ detail: string }>).map((r) => `${r.detail}`).join(" | ");
  });
}

describe("1.5.0 round 4: session start's rare-row lookups do not walk the namespace (100k gate)", () => {
  test("decisions, conventions and the open-task count use their own index, with or without a namespace", async () => {
    const { listTasks } = await import("../src/tasks.js");
    const s = bigStore(20_000, 0);
    const d = s.create({ namespace: "ns1", title: "Decision: use sqlite", body: "b" });
    raw(s).prepare("UPDATE notes SET obs_type = 'decision' WHERE id = ?").run(d.id);
    const c = s.create({ namespace: "ns1", title: "tabs not spaces", body: "b", tags: ["convention"] });
    s.create({ namespace: "ns1", title: "conventional wisdom", body: "b", tags: ["conventions"] }); // a near-miss tag
    const cases: Array<[string, () => unknown, RegExp]> = [
      ["decisions ns", () => s.list({ namespace: "ns1", obsTypes: ["decision"], limit: 10, count: false } as any), /idx_notes_obs/],
      ["decisions all", () => s.list({ obsTypes: ["decision"], limit: 10, count: false } as any), /idx_notes_obs/],
      ["conventions ns", () => s.list({ namespace: "ns1", withTags: ["convention"], withoutTags: ["task"], limit: 10 }), /idx_notes_tag_convention/],
      ["conventions all", () => s.list({ withTags: ["convention"], limit: 10 }), /idx_notes_tag_convention/],
      ["open tasks", () => listTasks(s, { namespaces: ["ns1"], limit: 1 }), /idx_notes_tag_task/],
      ["latest summary", () => s.list({ namespace: "ns1", kinds: ["summary"], limit: 5, count: false } as any), /idx_notes_kind_summary/],
      ["latest summary all", () => s.list({ kinds: ["summary"], limit: 5, count: false } as any), /idx_notes_kind_summary/],
      ["pinned", () => s.pinnedNotes(["ns1"]), /idx_notes_pinned/],
      ["pinned all", () => s.pinnedNotes(), /idx_notes_pinned/],
      ["facts", () => s.liveFactNotesIn("ns1"), /idx_notes_facts/],
      ["facts all", () => s.liveFactNotesIn(undefined), /idx_notes_facts/],
    ];
    for (const [name, fn, idx] of cases) {
      const plans = plansOf(s, fn);
      assert.ok(plans.length, name);
      for (const p of plans) {
        assert.match(p, idx, `${name}: ${p}`);
        assert.doesNotMatch(p, /SCAN notes(?! USING)/, `${name}: ${p}`);
      }
    }
    assert.deepEqual(s.list({ namespace: "ns1", obsTypes: ["decision"] } as any).notes.map((n) => n.id), [d.id]);
    assert.deepEqual(s.list({ withTags: ["convention"] }).notes.map((n) => n.id), [c.id]);
    assert.equal(s.list({ withTags: ["convention"] }).total, 1);
    const sum = s.create({ namespace: "ns1", title: "Session: x", body: "b" }, { kind: "summary", sessionId: "s", writtenBy: "capture" } as any);
    assert.deepEqual(s.list({ namespace: "ns1", kinds: ["summary"] } as any).notes.map((n) => n.id), [sum.id]);
    raw(s).prepare("UPDATE notes SET pinned = 1 WHERE id = ?").run(c.id);
    assert.deepEqual(s.pinnedNotes(["ns1"]).map((n) => n.id), [c.id]);
    const f = s.create({ namespace: "ns1", title: "port", body: "b", tags: ["fact:port=80"] });
    assert.deepEqual(s.liveFactNotesIn("ns1").map((n) => n.id), [f.id]);
    s.close();
  });

  test("a store without the new indexes (made before them) still lists the same rows", () => {
    const s = bigStore(50, 0);
    const c = s.create({ namespace: "ns1", title: "tabs", body: "b", tags: ["convention"] });
    raw(s).prepare("UPDATE notes SET pinned = 1 WHERE id = ?").run(c.id);
    const f = s.create({ namespace: "ns1", title: "port", body: "b", tags: ["fact:port=80"] });
    raw(s).exec("DROP INDEX idx_notes_tag_convention; DROP INDEX idx_notes_tag_task; DROP INDEX idx_notes_pinned; DROP INDEX idx_notes_facts; DROP INDEX idx_notes_kind_summary;");
    (s as any).tagIndexCache = undefined;
    assert.deepEqual(s.list({ withTags: ["convention"] }).notes.map((n) => n.id), [c.id]);
    assert.deepEqual(s.pinnedNotes().map((n) => n.id), [c.id]);
    assert.deepEqual(s.liveFactNotesIn(undefined).map((n) => n.id), [f.id]);
    assert.deepEqual(s.list({ kinds: ["summary"] } as any).notes, []);
    s.close();
  });

  test("recent file paths look at the newest notes only, not every note in the namespace", () => {
    const s = bigStore(20_000, 0);
    for (const ns of ["ns1", undefined]) {
      const plans = plansOf(s, () => s.recentFilePaths(ns, 30));
      assert.ok(plans.length);
      for (const p of plans) assert.doesNotMatch(p, /USE TEMP B-TREE FOR ORDER BY \| .*nf|SCAN notes USING INDEX idx_notes_ns_updated/, p);
    }
    // Still right: the newest linked file first.
    const a = s.create({ namespace: "ns1", title: "a", body: "b" });
    raw(s).prepare("INSERT INTO note_files (note_id, path, action) VALUES (?, 'src/a.ts', 'edit')").run(a.id);
    assert.deepEqual(s.recentFilePaths("ns1", 5), ["src/a.ts"]);
    s.close();
  });
});

describe("1.5.0 round 4: session start's memory count stops at a cap", () => {
  test("past SESSION_COUNT_CAP the lead line says N+ instead of reading every row; below it, the exact count", async () => {
    const { injectContext, SESSION_COUNT_CAP } = await import("../src/context-inject.js");
    const noGit = { branch: null, diffFiles: [] } as any;
    const s = bigStore(SESSION_COUNT_CAP + 50, 0);
    const text = await injectContext(s, { signals: noGit, tokens: 300, namespace: "ns1" });
    // ns1 holds ~1/7 of the rows: under the cap, exact.
    const inNs1 = s.list({ namespace: "ns1", limit: 1 }).total;
    assert.ok(text.includes(` of ${inNs1} memories`), text.slice(-300));
    const all = await injectContext(s, { signals: noGit, tokens: 300 });
    assert.ok(all.includes(` of ${SESSION_COUNT_CAP.toLocaleString("en-US")}+ memories`), all.slice(-300));
    s.close();
  });
});
