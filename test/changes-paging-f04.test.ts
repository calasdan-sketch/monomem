// 1.5.0 (round 2, F-04): the change feed streams a page in seq order; every page equals the brute-force answer
// (one entry per note: its last event in the window, "created" if the note was born in the window, "deleted" if it died).
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";

type Row = { seq: number; note_id: number; kind: string; namespace: string; source: string; title: string };
type Want = { seq: number; id: number; kind: string };

function oracle(rows: Row[], from: number, to: number, keep: (r: Row) => boolean): Want[] {
  const ev = rows.filter((r) => r.seq > from && r.seq <= to && keep(r));
  const byNote = new Map<number, Row[]>();
  for (const r of ev) byNote.set(r.note_id, [...(byNote.get(r.note_id) ?? []), r]);
  return [...byNote.values()]
    .map((list) => {
      const last = list[list.length - 1];
      return { seq: last.seq, id: last.note_id, kind: last.kind === "deleted" ? "deleted" : list.some((r) => r.kind === "created") ? "created" : "updated" };
    })
    .sort((a, b) => a.seq - b.seq);
}

function pageAll(s: Store, opts: Parameters<Store["changes"]>[0]): Want[] {
  const out: Want[] = [];
  let p = s.changes(opts);
  for (;;) {
    for (const c of p.changes) out.push({ seq: 0, id: c.id, kind: c.kind });
    if (!p.nextCursor) return out;
    p = s.changes({ cursor: p.nextCursor, limit: opts.limit, namespaces: opts.namespaces, source: opts.source });
  }
}

test("F-04 paging the feed equals the brute-force window answer, for several page sizes and filters", () => {
  const s = new Store(":memory:");
  try {
    const ids: number[] = [];
    for (let i = 0; i < 90; i++) ids.push(s.create({ namespace: i % 3 ? "a" : "b", title: `n${i}`, body: `b${i}`, source: i % 4 ? "mcp" : "cli" }).id);
    // an early window marker: everything above `mid` is the window, so some notes are born BEFORE it
    const mid = Number((s.captureDb().prepare("SELECT MAX(seq) AS m FROM change_log").get() as { m: number }).m);
    for (let i = 0; i < 90; i += 2) s.update(ids[i], { title: `n${i} v2`, body: `b${i} v2` });
    for (let i = 0; i < 90; i += 6) s.update(ids[i], { title: `n${i} v3`, body: `b${i} v3` });
    for (let i = 1; i < 90; i += 9) s.delete(ids[i]);
    for (let i = 0; i < 20; i++) ids.push(s.create({ namespace: "a", title: `late${i}`, body: "x", source: "mcp" }).id);
    const rows = s.captureDb().prepare("SELECT seq, note_id, kind, namespace, source, title FROM change_log ORDER BY seq").all() as unknown as Row[];
    const to = rows[rows.length - 1].seq;

    const cases: Array<{ name: string; from: number; opts: Parameters<Store["changes"]>[0]; keep: (r: Row) => boolean }> = [
      { name: "whole feed", from: 0, opts: {}, keep: () => true },
      { name: "namespace a", from: 0, opts: { namespaces: ["a"] }, keep: (r) => r.namespace === "a" },
      { name: "source cli", from: 0, opts: { source: "cli" }, keep: (r) => r.source === "cli" },
      { name: "window after mid", from: mid, opts: { fromSeq: mid }, keep: () => true },
    ];
    for (const c of cases) {
      const want = oracle(rows, c.from, to, c.keep).map(({ id, kind }) => ({ seq: 0, id, kind }));
      assert.ok(want.length > 10, c.name);
      for (const limit of [1, 7, 100]) {
        assert.deepEqual(pageAll(s, { since: "1970-01-01T00:00:00Z", limit, ...c.opts }), want, `${c.name}, limit ${limit}`);
      }
    }
    // tail: the newest N entries of the window, oldest first
    const all = oracle(rows, 0, to, () => true);
    const tail = s.changes({ since: "1970-01-01T00:00:00Z", tail: 5 }).changes.map((x) => ({ id: x.id, kind: x.kind }));
    assert.deepEqual(tail, all.slice(-5).map(({ id, kind }) => ({ id, kind })));
  } finally {
    s.close();
  }
});
