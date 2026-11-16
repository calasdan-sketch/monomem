// Embeddings + semantic/hybrid search. embed() must NEVER throw -- every
// failure path returns null so search falls back to keyword. And runSearch's
// semantic / hybrid / fallback branches (dark until now because no test ever
// turned embeddings on) are exercised with a stubbed fetch and preloaded
// vectors, so no real embedding server is needed.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { embed, embeddingsConfig, resetEmbeddingsAuto, clearQueryVectors, type EmbeddingsConfig } from "../src/embeddings.js";
import { runSearch } from "../src/search-service.js";

const CFG: EmbeddingsConfig = {
  enabled: true,
  url: "http://embeddings.local/v1/embeddings",
  model: "test-model",
  timeoutMs: 1000,
};

const realFetch = globalThis.fetch;
function stubFetch(fn: () => unknown): void {
  globalThis.fetch = (async () => fn()) as typeof fetch;
}
function openaiResponse(vec: number[]) {
  return { ok: true, status: 200, json: async () => ({ data: [{ embedding: vec }] }) };
}

describe("embed() failure paths all return null (never throw)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns null when embeddings are disabled (no fetch)", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return openaiResponse([1, 2, 3]);
    });
    assert.equal(await embed("hi", { ...CFG, enabled: false }), null);
    assert.equal(called, false);
  });

  test("returns null on empty text", async () => {
    assert.equal(await embed("   ", CFG), null);
  });

  test("returns null on a non-200 response", async () => {
    stubFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    assert.equal(await embed("hi", CFG), null);
  });

  test("returns null on a network error", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    assert.equal(await embed("hi", CFG), null);
  });

  test("returns null on an unrecognized response shape", async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ nope: true }) }));
    assert.equal(await embed("hi", CFG), null);
  });

  test("parses the OpenAI shape { data: [{ embedding }] }", async () => {
    stubFetch(() => openaiResponse([0.1, 0.2, 0.3]));
    const v = await embed("hi", CFG);
    assert.ok(v instanceof Float32Array);
    assert.equal(v?.length, 3);
  });

  test("parses the Ollama native shape { embedding }", async () => {
    stubFetch(() => ({ ok: true, status: 200, json: async () => ({ embedding: [1, 2] }) }));
    const v = await embed("hi", CFG);
    assert.equal(v?.length, 2);
  });
});

describe("runSearch semantic / hybrid / fallback", () => {
  let store: Store;
  const SAVE = process.env.MONOMEM_EMBEDDINGS;

  beforeEach(() => {
    process.env.MONOMEM_EMBEDDINGS = "on";
    clearQueryVectors(); // each test stubs its own endpoint; a vector cached by an earlier test would hide "endpoint down"
    store = new Store(":memory:");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (SAVE === undefined) delete process.env.MONOMEM_EMBEDDINGS;
    else process.env.MONOMEM_EMBEDDINGS = SAVE;
    store.close();
  });

  function seed() {
    const a = store.create({ title: "alpha", body: "we deploy on fly" });
    const b = store.create({ title: "beta", body: "unrelated note" });
    // Preload vectors so semantic ranking is deterministic. Query vector is
    // [1,0,0] (see stub): a is identical (cosine 1), b is off-axis (cosine ~0.6).
    store.setVector(a.id, Float32Array.from([1, 0, 0]), "test-model");
    store.setVector(b.id, Float32Array.from([0.6, 0.8, 0]), "test-model");
    return { a, b };
  }

  test("semantic mode ranks by vector similarity", async () => {
    const { a } = seed();
    stubFetch(() => openaiResponse([1, 0, 0])); // the query embedding
    const res = await runSearch(store, "deploy", { mode: "semantic" });
    assert.ok(res.length >= 1);
    assert.equal(res[0].id, a.id); // closest vector first
  });

  test("hybrid mode fuses keyword + semantic", async () => {
    const { a } = seed();
    stubFetch(() => openaiResponse([1, 0, 0]));
    const res = await runSearch(store, "deploy", { mode: "hybrid" });
    // "deploy" matches only note a by keyword; a is also the top vector -> a first.
    assert.equal(res[0].id, a.id);
  });

  test("falls back to keyword when the embedding endpoint is down", async () => {
    const { a } = seed();
    stubFetch(() => {
      throw new Error("endpoint down");
    });
    const res = await runSearch(store, "deploy", { mode: "hybrid" });
    // Query couldn't be embedded -> keyword path. "deploy" matches note a only.
    assert.equal(res.length, 1);
    assert.equal(res[0].id, a.id);
  });

  test("semantic mode ALSO falls back to keyword when the endpoint is down", async () => {
    // This bites specifically on the `if (!qv) return keyword()` guard: without
    // it, semantic mode would call semanticSearch(null) -> [] and return nothing.
    const { a } = seed();
    stubFetch(() => {
      throw new Error("endpoint down");
    });
    const res = await runSearch(store, "deploy", { mode: "semantic" });
    assert.equal(res.length, 1);
    assert.equal(res[0].id, a.id);
  });
});

describe("MONOMEM_EMBEDDINGS=auto", () => {
  const SAVE = { e: process.env.MONOMEM_EMBEDDINGS, t: process.env.MONOMEM_EMBED_TIMEOUT_MS };
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetEmbeddingsAuto();
    for (const [k, v] of [["MONOMEM_EMBEDDINGS", SAVE.e], ["MONOMEM_EMBED_TIMEOUT_MS", SAVE.t]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("on, with a short timeout unless one is set", () => {
    process.env.MONOMEM_EMBEDDINGS = "auto";
    delete process.env.MONOMEM_EMBED_TIMEOUT_MS;
    const c = embeddingsConfig();
    assert.equal(c.enabled, true);
    assert.equal(c.auto, true);
    assert.equal(c.timeoutMs, 5000);
    process.env.MONOMEM_EMBED_TIMEOUT_MS = "12000";
    assert.equal(embeddingsConfig().timeoutMs, 12000);
    process.env.MONOMEM_EMBEDDINGS = "on";
    assert.equal(embeddingsConfig().auto, undefined);
  });

  test("a backend that answers is used; one that does not is silent and not asked again for a while", async () => {
    const auto = { ...CFG, auto: true };
    let calls = 0;
    stubFetch(() => (calls++, openaiResponse([1, 0])));
    assert.equal((await embed("hi", auto))?.length, 2);
    const err = console.error;
    const logged: string[] = [];
    console.error = (m: string) => void logged.push(m);
    try {
      stubFetch(() => {
        calls++;
        throw new Error("ECONNREFUSED");
      });
      assert.equal(await embed("hi", auto), null);
      assert.equal(await embed("again", auto), null);
      assert.equal(calls, 2, "after a failure the endpoint is not asked again until the back-off ends");
      assert.deepEqual(logged, [], "auto mode is silent");
      resetEmbeddingsAuto();
      stubFetch(() => (calls++, openaiResponse([1, 0, 0])));
      assert.equal((await embed("hi", auto))?.length, 3, "back once the backend answers");
    } finally {
      console.error = err;
    }
  });

  test("search with auto and no backend is plain keyword search", async () => {
    process.env.MONOMEM_EMBEDDINGS = "auto";
    const s = new Store(":memory:");
    const a = s.create({ title: "alpha", body: "we deploy on fly" });
    s.create({ title: "beta", body: "unrelated" });
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await runSearch(s, "deploy", {});
    assert.deepEqual(res.map((n) => n.id), [a.id]);
    s.close();
  });
});

describe("round 4: a repeated search reuses its query vector", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("embedQuery calls the endpoint once per (endpoint, model, text); a failure is not remembered", async () => {
    const { embedQuery, clearQueryVectors } = await import("../src/embeddings.js");
    clearQueryVectors();
    let calls = 0;
    stubFetch(() => {
      calls++;
      return openaiResponse([1, 2, 3]);
    });
    const a = await embedQuery("deploy steps", CFG);
    const b = await embedQuery("deploy steps", CFG);
    assert.deepEqual([...b!], [1, 2, 3]);
    assert.equal(calls, 1, "second identical search hit the cache");
    assert.notEqual(a, b, "each caller gets its own copy (no shared mutable vector)");
    await embedQuery("deploy steps", { ...CFG, model: "other" });
    assert.equal(calls, 2, "another model is another vector");
    stubFetch(() => {
      calls++;
      return { ok: false, status: 500, json: async () => ({}) };
    });
    assert.equal(await embedQuery("new words", CFG), null);
    stubFetch(() => {
      calls++;
      return openaiResponse([4]);
    });
    assert.deepEqual([...(await embedQuery("new words", CFG))!], [4], "a failed call is retried, not cached as null");
    clearQueryVectors();
  });
});
