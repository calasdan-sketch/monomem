// MONOMEM_EMBEDDINGS=local: opt-in, in-process; a missing install is a quiet keyword fallback, never an error.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embed, embeddingsConfig } from "../src/embeddings.js";
import { localEmbedInstalled } from "../src/embeddings-local.js";
import { searchStatusText } from "../src/search-status.js";

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test("local is off unless asked for", () => {
  assert.equal(withEnv({ MONOMEM_EMBEDDINGS: "" }, () => embeddingsConfig().enabled), false);
  assert.equal(withEnv({ MONOMEM_EMBEDDINGS: "local" }, () => embeddingsConfig().local), true);
});

test("local with nothing installed returns null instead of throwing", async () => {
  const empty = mkdtempSync(join(tmpdir(), "mm-embed-"));
  await withEnv({ MONOMEM_EMBEDDINGS: "local", MONOMEM_LOCAL_EMBED_DIR: empty }, async () => {
    assert.equal(localEmbedInstalled(), false);
    assert.equal(await embed("hello", embeddingsConfig(), "query"), null);
  });
});

test("check says what search can and cannot do", () => {
  const off = withEnv({ MONOMEM_EMBEDDINGS: "" }, searchStatusText);
  assert.match(off, /synonyms/);
  assert.match(off, /off/);
  const missing = withEnv({ MONOMEM_EMBEDDINGS: "local", MONOMEM_LOCAL_EMBED_DIR: join(tmpdir(), "mm-nope") }, searchStatusText);
  assert.match(missing, /not installed/);
});
