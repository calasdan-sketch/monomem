// searchStem (search-side suffix trim) and its use in the any-keyword search.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { searchStem } from "../src/keywords.js";
import { anyKeywordHits } from "../src/search-service.js";

describe("searchStem", () => {
  test("trims plural s/es, ed and ing, undoubling a final consonant", () => {
    assert.equal(searchStem("bikes"), "bike");
    assert.equal(searchStem("watches"), "watch");
    assert.equal(searchStem("camped"), "camp");
    assert.equal(searchStem("camping"), "camp");
    assert.equal(searchStem("planning"), "plan");
    assert.equal(searchStem("painted"), "paint");
  });

  test("leaves short stems, -ss/-us/-ies/-eed, hashtags and words with digits alone", () => {
    for (const w of ["news", "going", "moved", "glass", "census", "stories", "agreed", "#camping", "q3s", "café"]) {
      assert.equal(searchStem(w), w);
    }
  });
});

describe("anyKeywordHits with stems", () => {
  test("a query word finds other forms of it, and the exact form ranks first", () => {
    const store = new Store(":memory:");
    try {
      const other = store.create({ title: "trip", body: "We went camping by the lake" }, { skipEdges: true, lint: "none" });
      const exact = store.create({ title: "trip", body: "We camped by the lake" }, { skipEdges: true, lint: "none" });
      store.create({ title: "unrelated", body: "Groceries and a lamp" }, { skipEdges: true, lint: "none" });
      const ids = anyKeywordHits(store, ["camped", "lake"], 10, {}).map((h) => h.note.id);
      assert.deepEqual(ids, [exact.id, other.id]);
    } finally {
      store.close();
    }
  });
});
