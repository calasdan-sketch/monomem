// 31-M6: a failed local-model load is not cached forever, says why once, labels vectors with the local model, and check counts mismatches.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { localEmbed, resetLocalEmbed, LOAD_RETRY_MS, LOCAL_MODEL } from "../src/embeddings-local.js";
import { vectorModelLabel, embeddingsConfig } from "../src/embeddings.js";
import { vectorMismatch, vectorMismatchText } from "../src/store/vector-audit.js";
import { Store } from "../src/store.js";

test("a failed load warns once, is not retried at once, and is retried after the delay", async () => {
  let calls = 0;
  const warnings: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  const realNow = Date.now;
  process.stderr.write = ((s: string | Uint8Array) => (warnings.push(String(s)), true)) as typeof process.stderr.write;
  try {
    resetLocalEmbed(async () => {
      if (++calls === 1) throw new Error("cannot find package @huggingface/transformers");
      return async () => ({ data: new Float32Array([1, 0, 0]) });
    });
    assert.equal(await localEmbed("a", "passage"), null);
    assert.equal(await localEmbed("b", "passage"), null);
    assert.equal(calls, 1, "not retried inside the delay");
    assert.equal(warnings.filter((w) => /local embeddings: could not load the model \(cannot find package/.test(w)).length, 1, "one clear warning");
    Date.now = () => realNow() + LOAD_RETRY_MS + 1000;
    assert.deepEqual(Array.from((await localEmbed("c", "passage")) ?? []), [1, 0, 0]);
    assert.equal(calls, 2);
  } finally {
    process.stderr.write = realWrite;
    Date.now = realNow;
    resetLocalEmbed();
  }
});

test("vectors made locally carry the local model's name, and check counts the ones made by another model", () => {
  process.env.MONOMEM_EMBEDDINGS = "local";
  try {
    assert.equal(vectorModelLabel(embeddingsConfig()), LOCAL_MODEL);
  } finally {
    delete process.env.MONOMEM_EMBEDDINGS;
  }
  const s = new Store(":memory:");
  const a = s.create({ title: "a", body: "x" }).id;
  const b = s.create({ title: "b", body: "y" }).id;
  s.setVector(a, new Float32Array(384), LOCAL_MODEL);
  s.setVector(b, new Float32Array(768), "nomic-embed-text");
  const m = vectorMismatch(s.captureDb(), LOCAL_MODEL, 384);
  assert.deepEqual(m, { mismatched: 1, total: 2 });
  assert.match(vectorMismatchText(m), /1 of 2 stored meaning vectors .*run monomem reindex/);
  assert.equal(vectorMismatchText({ mismatched: 0, total: 2 }), "");
  s.close();
});
