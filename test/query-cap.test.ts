// A search longer than 4096 characters or 64 words is refused with a clear message on every route, and the FTS builder cuts it anyway.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store, ValidationError, queryTooLong, QUERY_MAX_CHARS, QUERY_MAX_WORDS } from "../src/store.js";
import { runSearch, runRelevantSearch } from "../src/search-service.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";

test("queryTooLong: the limits, in characters and words", () => {
  assert.equal(queryTooLong("short query"), "");
  assert.equal(queryTooLong("a ".repeat(QUERY_MAX_WORDS)), "");
  assert.match(queryTooLong("a ".repeat(QUERY_MAX_WORDS + 1)), /65 words/);
  assert.match(queryTooLong("x".repeat(QUERY_MAX_CHARS + 1)), /4097 characters/);
});

test("a 1 MB search is refused at once on search and relevant; the store itself cuts it and answers fast", async () => {
  const s = new Store(":memory:");
  for (let i = 0; i < 50; i++) s.create({ title: `note ${i}`, body: "alpha beta gamma" });
  const big = "alpha ".repeat(180_000);
  let t = Date.now();
  await assert.rejects(runSearch(s, big), ValidationError);
  await assert.rejects(runRelevantSearch(s, big), ValidationError);
  assert.ok(Date.now() - t < 500);
  t = Date.now();
  assert.ok(s.searchRanked(big, { anyTerm: true }).length > 0, "the cut query still searches");
  assert.ok(Date.now() - t < 2000, `took ${Date.now() - t} ms`);
  s.close();
});

test("ceilings still apply to a search that is within the cap", async () => {
  const s = new Store(":memory:");
  actorStore.run({ label: "a", authed: true }, () => s.create({ title: "hidden zebra", body: "zebra", sensitivity: "private" }));
  const seen = await actorStore.run({ label: "lim", authed: true, maxSensitivity: "internal", canDeclassify: false }, () => runSearch(s, "zebra"));
  assert.equal(seen.length, 0);
  s.close();
});

test("REST /search answers 400 with the reason for a long query", async () => {
  const s = new Store(":memory:");
  const tok = "t".repeat(40);
  const server = createApiServer(s, [{ token: tok, scope: "admin", label: "op" }]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r = await fetch(`${base}/search?q=${encodeURIComponent("word ".repeat(70))}`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /too long/);
  const ok = await fetch(`${base}/search?q=word`, { headers: { Authorization: `Bearer ${tok}` } });
  assert.equal(ok.status, 200);
  await new Promise<void>((r2) => server.close(() => r2()));
  s.close();
});
