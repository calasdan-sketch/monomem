// restatedPairs now scans newest-first and stops at the first valid newer note. This pins that it still returns EXACTLY what the original
// scan-everything version returned, on random stores that include ties, unreadable dates, distrusted and held notes, person-confirmed notes,
// fact clashes, similarity links, several writers and a result cap. The reference below is a copy of the original loop.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { restatedPairs } from "../src/quality.js";
import { factClash } from "../src/facts.js";
import { heldFromSessionStart } from "../src/taint.js";
import { RESTATE_MIN_SIM } from "../src/search-service.js";
import type { Store, NoteRecord } from "../src/store.js";

const writerKey = (n: NoteRecord): string => JSON.stringify([n.namespace, n.written_by, n.writer_id ?? ""]);
const personConfirmed = (n: NoteRecord): boolean => (n.confirmed_kind === "human" || n.confirmed_kind === "admin") && n.confirmed_rev === n.rev;

function reference(store: Store, notes: NoteRecord[], max = Infinity): Array<[NoteRecord, NoteRecord]> {
  const enforce = false;
  const plain = notes.filter((n) => (n.kind ?? "note") === "note" && !n.superseded_by);
  const groups = new Map<string, NoteRecord[]>();
  for (const n of plain) {
    const k = writerKey(n);
    const g = groups.get(k);
    if (g) g.push(n);
    else groups.set(k, [n]);
  }
  const created = new Map(plain.map((n) => [n.id, Date.parse(n.created_at)]));
  const out: Array<[NoteRecord, NoteRecord]> = [];
  for (const o of plain) {
    let best: NoteRecord | undefined;
    let sims: Map<number, number> | undefined;
    const oUpdated = Date.parse(o.updated_at);
    for (const n of groups.get(writerKey(o))!) {
      if (n.id === o.id || !(created.get(n.id)! > oUpdated)) continue;
      if (best && created.get(n.id)! <= created.get(best.id)!) continue;
      if (n.distrusted || heldFromSessionStart(n, enforce) || (personConfirmed(o) && !personConfirmed(n))) continue;
      const sameSubject = factClash(o.tags ?? [], n.tags ?? []) || ((sims ??= store.neighbourScores(o.id)).get(n.id) ?? 0) >= RESTATE_MIN_SIM;
      if (sameSubject && !(typeof store.isDistrusted === "function" && store.isDistrusted(n))) best = n;
    }
    if (best && out.push([o, best]) >= max) break;
  }
  return out;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function world(seed: number, n: number) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const days = [0, 1, 1, 2, 3, 5, 5, 8, 13]; // few distinct dates on purpose: ties are common
  const iso = (d: number) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString();
  const notes: NoteRecord[] = Array.from({ length: n }, (_, i) => {
    const c = r() < 0.04 ? "not a date" : iso(pick(days));
    const u = r() < 0.04 ? "not a date" : r() < 0.5 ? c : iso(pick(days));
    return {
      id: i + 1,
      namespace: pick(["a", "b"]),
      written_by: pick(["w1", "w2"]),
      writer_id: pick(["", "k1"]),
      kind: r() < 0.05 ? "task" : "note",
      superseded_by: r() < 0.05 ? 99 : undefined,
      created_at: c,
      updated_at: u,
      tags: r() < 0.5 ? [`fact:db=${pick(["pg", "mysql"])}`] : r() < 0.2 ? ["fact:port=1"] : [],
      distrusted: r() < 0.06 ? true : undefined,
      unconfirmed: r() < 0.06 ? true : undefined,
      confirmed_kind: r() < 0.15 ? "human" : undefined,
      confirmed_rev: 1,
      rev: r() < 0.9 ? 1 : 2,
    } as unknown as NoteRecord;
  });
  const links = new Map<number, Map<number, number>>();
  for (const a of notes) {
    const m = new Map<number, number>();
    for (const b of notes) if (a.id !== b.id && r() < 0.03) m.set(b.id, r() < 0.5 ? 0.9 : 0.1);
    links.set(a.id, m);
  }
  const distrusted = new Set(notes.filter(() => r() < 0.04).map((x) => x.id));
  const calls = { n: 0 };
  const store = {
    confirmSettings: () => ({ mode: "off" }),
    neighbourScores: (id: number) => {
      calls.n++;
      return links.get(id) ?? new Map<number, number>();
    },
    isDistrusted: (note: NoteRecord) => distrusted.has(note.id),
  } as unknown as Store;
  return { notes, store, calls };
}

test("the newest-first scan returns exactly what the original scan returned, on 300 random stores, with and without a cap", () => {
  let nonEmpty = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const w = world(seed, 12 + (seed % 40));
    for (const max of [Infinity, 3]) {
      const want = reference(w.store, w.notes, max).map(([o, n]) => [o.id, n.id]);
      const got = restatedPairs(w.store, w.notes, max).map(([o, n]) => [o.id, n.id]);
      assert.deepEqual(got, want, `seed ${seed} max ${max}`);
      if (want.length) nonEmpty++;
    }
  }
  assert.ok(nonEmpty > 200, `the random stores must produce real pairs (non-empty results: ${nonEmpty})`);
});

test("it asks for far fewer similarity lookups than the original on a large single-writer store", () => {
  const w = world(7, 600);
  const count = (f: () => unknown): number => {
    w.calls.n = 0;
    f();
    return w.calls.n;
  };
  const before = count(() => reference(w.store, w.notes));
  const after = count(() => restatedPairs(w.store, w.notes));
  assert.ok(after < before, `${after} lookups after, ${before} before: the early stop must save work`);
});
