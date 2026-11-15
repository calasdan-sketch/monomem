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

describe("rarity-weighted coverage", () => {
  test("a note with the question's rare word outranks one with only its common words", () => {
    const store = new Store(":memory:");
    try {
      for (let i = 0; i < 8; i++) store.create({ title: `day ${i}`, body: "a walk in the park today" }, { skipEdges: true, lint: "none" });
      const common = store.create({ title: "notes", body: "walk park walk park" }, { skipEdges: true, lint: "none" });
      const rare = store.create({ title: "notes", body: "the saxophone lesson" }, { skipEdges: true, lint: "none" });
      const ids = anyKeywordHits(store, ["walk", "park", "saxophone"], 20, {}).map((h) => h.note.id);
      assert.ok(ids.indexOf(rare.id) < ids.indexOf(common.id), `rare ${ids.indexOf(rare.id)} vs common ${ids.indexOf(common.id)}`);
    } finally {
      store.close();
    }
  });

  test("prefixDocFreqs counts live notes per prefix, capped at the note count", () => {
    const store = new Store(":memory:");
    try {
      store.create({ title: "a", body: "camp camping" }, { skipEdges: true, lint: "none" });
      store.create({ title: "b", body: "camped once" }, { skipEdges: true, lint: "none" });
      store.create({ title: "c", body: "nothing here" }, { skipEdges: true, lint: "none" });
      const { n, df } = store.prefixDocFreqs(["camp", "zebra"]);
      assert.equal(n, 3);
      assert.equal(df.get("camp"), 3); // 2 notes, "camp"+"camping" counted twice in one: capped at n
      assert.equal(df.get("zebra"), 0);
    } finally {
      store.close();
    }
  });
});

test("prefixDocFreqs reuses its counts for small changes and refreshes once the store size moves past the tolerance", () => {
  const store = new Store(":memory:");
  try {
    store.create({ title: "a", body: "zebra" }, { skipEdges: true, lint: "none" });
    assert.equal(store.prefixDocFreqs(["zebra"]).df.get("zebra"), 1);
    store.create({ title: "b", body: "zebra" }, { skipEdges: true, lint: "none" });
    assert.equal(store.prefixDocFreqs(["zebra"]).df.get("zebra"), 1, "within tolerance: the cached weight is reused");
    for (let i = 0; i < 12; i++) store.create({ title: `c${i}`, body: "zebra" }, { skipEdges: true, lint: "none" });
    assert.equal(store.prefixDocFreqs(["zebra"]).df.get("zebra"), 14, "past the tolerance: counted again");
  } finally {
    store.close();
  }
});
