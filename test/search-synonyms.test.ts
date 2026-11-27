// Model-free synonym widening: a word no found note holds is also searched under its synonyms.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { runSearch } from "../src/search-service.js";
import { synonymsFor } from "../src/search-synonyms.js";
import { cjkBigrams } from "../src/store/cjk-search.js";

const ids = async (s: Store, q: string): Promise<number[]> => (await runSearch(s, q, { mode: "keyword", limit: 5 })).map((n) => n.id);

test("irregular and inflected forms reach the same synonyms", () => {
  assert.ok(synonymsFor("fired").some((r) => r.startsWith("terminat")));
  assert.ok(synonymsFor("cars").includes("automobil"));
  assert.deepEqual(synonymsFor("zebracorn"), []);
});

test("a synonym query finds the note that uses the other word", async () => {
  const s = new Store(":memory:");
  const car = s.create({ title: "Garage", body: "The company automobile must be returned by Friday." });
  s.create({ title: "Lunch", body: "Pizza on Fridays." });
  assert.equal((await ids(s, "where should I park my car"))[0], car.id);
  const fired = s.create({ title: "HR", body: "The contractor was terminated for missing deadlines." });
  assert.equal((await ids(s, "who got fired"))[0], fired.id);
});

test("a word the store already has is not widened (an exact match keeps the top spot)", async () => {
  const s = new Store(":memory:");
  const exact = s.create({ title: "Car", body: "Our car is parked outside." });
  s.create({ title: "Garage", body: "The company automobile must be returned." });
  assert.deepEqual(await ids(s, "car"), [exact.id]);
});

test("katakana with the long-vowel mark stays one run for the CJK search", () => {
  assert.ok(cjkBigrams("データの保存").includes("ータ"));
});
