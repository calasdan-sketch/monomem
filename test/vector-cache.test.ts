import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";

// Round 8 speed: semanticSearch keeps the vectors in memory between queries. Whatever the cache does, the answer must be
// the one a fresh scan of the table gives (same ids, same order, same float scores) -- also after any write.
const DIM = 16;
function rng(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(1);
const vec = (d = DIM): Float32Array => Float32Array.from({ length: d }, () => r() - 0.5);
const key = (s: Store, q: Float32Array, o: { namespace?: string } = {}): string => JSON.stringify(s.semanticSearch(q, { limit: 50, ...o }).map((h) => [h.note.id, h.score]));
/** The reference answer: the same store with the cache switched off. */
function fresh(s: Store, q: Float32Array, o: { namespace?: string } = {}): string {
  const old = process.env.MONOMEM_VECTOR_CACHE_MB;
  process.env.MONOMEM_VECTOR_CACHE_MB = "0";
  try { return key(s, q, o); } finally { if (old === undefined) delete process.env.MONOMEM_VECTOR_CACHE_MB; else process.env.MONOMEM_VECTOR_CACHE_MB = old; }
}

describe("semanticSearch vector cache", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const open = (): { a: Store; b: Store } => {
    const d = mkdtempSync(join(tmpdir(), "mm-vc-")); dirs.push(d);
    return { a: new Store(join(d, "s.db")), b: new Store(join(d, "s.db")) };
  };
  const fill = (s: Store, n: number, ns?: string): number[] => Array.from({ length: n }, (_, i) => { const id = s.create({ title: `n${i} ${r()}`, ...(ns ? { namespace: ns } : {}) }, { skipEdges: true, lint: "none" }).id; s.setVector(id, vec(), "t"); return id; });

  test("same ids, order and scores as an uncached scan", () => {
    const { a, b } = open(); fill(a, 60); fill(a, 10, "other");
    const q = vec();
    assert.equal(key(a, q), fresh(a, q));
    assert.equal(key(a, q), fresh(a, q)); // second call is served from memory
    assert.equal(key(a, q, { namespace: "other" }), fresh(a, q, { namespace: "other" }));
    a.close(); b.close();
  });

  test("a vector written by this store shows up (new and replaced)", () => {
    const { a, b } = open(); const ids = fill(a, 30); const q = vec();
    key(a, q);
    const nid = a.create({ title: "late" }, { skipEdges: true, lint: "none" }).id; a.setVector(nid, q, "t"); // exact match -> must be first
    assert.equal(a.semanticSearch(q)[0].note.id, nid);
    a.setVector(ids[3], q, "t"); a.setVector(ids[3], vec(), "t");
    assert.equal(key(a, q), fresh(a, q));
    a.close(); b.close();
  });

  test("a vector written by ANOTHER connection shows up", () => {
    const { a, b } = open(); fill(a, 30); const q = vec();
    key(a, q); // warm
    const nid = b.create({ title: "from b" }, { skipEdges: true, lint: "none" }).id; b.setVector(nid, q, "t");
    assert.equal(a.semanticSearch(q)[0].note.id, nid);
    const first = a.semanticSearch(q)[1].note.id; b.setVector(first, vec(), "t"); // replace by the other connection
    assert.equal(key(a, q), fresh(a, q));
    a.close(); b.close();
  });

  test("a forgotten note and an edited note drop out of the vector results", () => {
    const { a, b } = open(); const ids = fill(a, 30); const q = vec();
    key(a, q);
    a.setVector(ids[0], q, "t");
    assert.equal(a.semanticSearch(q)[0].note.id, ids[0]);
    a.archive(ids[0]);
    assert.ok(!a.semanticSearch(q).some((h) => h.note.id === ids[0]));
    assert.equal(key(a, q), fresh(a, q));
    a.close(); b.close();
  });

  test("a query of another dimension is skipped, then the cache serves it after a model switch", () => {
    const { a, b } = open(); fill(a, 10);
    assert.equal(a.semanticSearch(vec(8)).length, 0);
    const id = a.create({ title: "d8" }, { skipEdges: true, lint: "none" }).id; a.setVector(id, vec(8), "t");
    const q8 = vec(8);
    assert.equal(key(a, q8), fresh(a, q8));
    assert.equal(a.semanticSearch(q8).length, 1);
    const q = vec(); assert.equal(key(a, q), fresh(a, q));
    a.close(); b.close();
  });

  test("r10 H1: another connection replaces a vector, then THIS store writes one: the next search sees the replacement", async () => {
    const { a, b } = open();
    const unit = (x: number): Float32Array => { const f = new Float32Array(DIM); f[x] = 1; return f; };
    const ids = [0, 1, 2].map((i) => { const id = a.create({ title: `u${i}` }, { skipEdges: true, lint: "none" }).id; a.setVector(id, unit(i), "t"); return id; });
    const q = unit(0);
    assert.equal(a.semanticSearch(q)[0].note.id, ids[0]); // warm: note 0 matches with score 1
    await new Promise((r) => setTimeout(r, 5));
    b.setVector(ids[0], unit(3), "t"); // the other process makes note 0 orthogonal to the query
    await new Promise((r) => setTimeout(r, 5));
    a.setVector(ids[1], unit(1), "t"); // an own write, newer than b's
    assert.deepEqual(a.semanticSearch(q).map((h) => h.note.id), [], "note 0's old vector was served from the cache");
    assert.equal(key(a, q), fresh(a, q));
    a.close(); b.close();
  });

  test("r10 H1: another connection replaces a vector with an OLDER timestamp than the newest row: still seen", () => {
    const { a, b } = open();
    const unit = (x: number): Float32Array => { const f = new Float32Array(DIM); f[x] = 1; return f; };
    const ids = [0, 1].map((i) => { const id = a.create({ title: `w${i}` }, { skipEdges: true, lint: "none" }).id; a.setVector(id, unit(i), "t"); return id; });
    const q = unit(0);
    assert.equal(a.semanticSearch(q)[0].note.id, ids[0]);
    // b's clock is behind (or its reindex embed was slow): its row keeps a timestamp older than a's newest one
    b.setVector(ids[0], unit(3), "t");
    (b as unknown as { db: { prepare(s: string): { run(...p: unknown[]): unknown } } }).db.prepare("UPDATE note_vectors SET updated_at = ? WHERE note_id = ?").run("2000-01-01T00:00:00.000Z", ids[0]);
    assert.deepEqual(a.semanticSearch(q).map((h) => h.note.id), []);
    a.close(); b.close();
  });

  test("r10 L5: a hard delete drops the in-memory copy", () => {
    const { a, b } = open(); const ids = fill(a, 5); const q = vec();
    key(a, q);
    const holder = (a as unknown as { vecCache: { cache: unknown } }).vecCache;
    assert.ok(holder.cache !== null, "warm");
    assert.ok(a.delete(ids[0]));
    assert.ok(holder.cache === null, "the hard delete left the vector copy in memory");
    assert.equal(key(a, q), fresh(a, q));
    a.close(); b.close();
  });

  test("MONOMEM_VECTOR_CACHE_MB too small for the table: still correct", () => {
    const { a, b } = open(); fill(a, 40); const q = vec();
    const old = process.env.MONOMEM_VECTOR_CACHE_MB; process.env.MONOMEM_VECTOR_CACHE_MB = "0.0001";
    try { assert.equal(key(a, q), fresh(a, q)); } finally { if (old === undefined) delete process.env.MONOMEM_VECTOR_CACHE_MB; else process.env.MONOMEM_VECTOR_CACHE_MB = old; }
    a.close(); b.close();
  });
});
