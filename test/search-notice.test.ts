import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { semanticNotice, SEMANTIC_NOTICE } from "../src/search-service.js";

test("semanticNotice: only when semantic or hybrid was asked for and no embedding service is on", () => {
  const saved = process.env.MONOMEM_EMBEDDINGS;
  delete process.env.MONOMEM_EMBEDDINGS;
  try {
    assert.equal(semanticNotice("semantic"), SEMANTIC_NOTICE);
    assert.equal(semanticNotice("hybrid"), SEMANTIC_NOTICE);
    assert.equal(semanticNotice("keyword"), undefined);
    assert.equal(semanticNotice(undefined), undefined);
    process.env.MONOMEM_EMBEDDINGS = "on";
    assert.equal(semanticNotice("semantic"), undefined);
  } finally {
    if (saved === undefined) delete process.env.MONOMEM_EMBEDDINGS; else process.env.MONOMEM_EMBEDDINGS = saved;
  }
});

test("REST: the notice rides along on /search without changing the results; mostAccessed leaves out notes nobody read", async () => {
  const s = new Store(":memory:");
  s.create({ title: "zebra one", body: "zebra" });
  s.create({ title: "unread", body: "never opened" });
  const tok = "t".repeat(40);
  const server = createApiServer(s, [{ token: tok, scope: "admin", label: "op" }]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string): Promise<any> => (await fetch(base + p, { headers: { Authorization: `Bearer ${tok}` } })).json();
  const kw = await get("/search?q=zebra&mode=keyword");
  const sem = await get("/search?q=zebra&mode=semantic");
  assert.equal(kw.notice, undefined);
  assert.match(sem.notice, /semantic search is not set up; showing keyword results/);
  assert.deepEqual(sem.results.map((n: { id: number }) => n.id), kw.results.map((n: { id: number }) => n.id), "same results, same order");
  const stats = await get("/stats");
  const top = (stats.mostAccessed ?? stats.access?.mostAccessed ?? []) as Array<{ title: string; access_count: number }>;
  assert.ok(top.every((t) => t.access_count > 0), JSON.stringify(top));
  assert.ok(!top.some((t) => t.title === "unread"));
  await new Promise<void>((r) => server.close(() => r()));
  s.close();
});
