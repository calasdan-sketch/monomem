// Expert round 1, item 8: does memory_search (MCP) really use embeddings in hybrid mode, and does `reindex` survive a cold model?
// The embedding server here is a stub with hand-made vectors, so this proves the wiring (a query is embedded, notes carry
// vectors, a meaning-only match comes back), NOT how well a real embedding model ranks. Not run here: a real model.
import "./setup-env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { reindexEmbedder, COLD_FIRST_TIMEOUT_MS, RETRY_TIMEOUT_MS } from "../src/embed-retry.js";
import { embeddingsConfig } from "../src/embeddings.js";

const realFetch = globalThis.fetch;
const SAVE = { on: process.env.MONOMEM_EMBEDDINGS, url: process.env.MONOMEM_EMBED_URL };
let embedCalls: string[] = [];

/** Hosting words point one way, everything else another: "hosted" and "deployed on Fly.io" share no keyword but share a vector. */
const vecFor = (text: string): number[] => (/hosted|deployed|fly\.io/i.test(text) ? [1, 0, 0] : [0, 1, 0]);

function stubEmbeddings(): void {
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (!String(url).includes("/v1/embeddings")) return realFetch(url as string, init as never);
    const input = (JSON.parse(init?.body ?? "{}") as { input?: string }).input ?? "";
    embedCalls.push(input);
    return { ok: true, status: 200, json: async () => ({ data: [{ embedding: vecFor(input) }] }) };
  }) as typeof fetch;
}

async function connect(store: Store): Promise<Client> {
  const server = createMcpServer(store, "admin");
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}
const search = async (client: Client, args: Record<string, unknown>): Promise<any> => {
  const r: any = await client.callTool({ name: "state_search", arguments: args });
  const t: string = r.content[0].text;
  return JSON.parse(t.slice(t.indexOf("{")));
};

describe("memory_search over MCP with embeddings on", () => {
  beforeEach(() => {
    embedCalls = [];
    process.env.MONOMEM_EMBEDDINGS = "on";
    process.env.MONOMEM_EMBED_URL = "http://localhost:11434/v1/embeddings";
    stubEmbeddings();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [k, v] of [["MONOMEM_EMBEDDINGS", SAVE.on], ["MONOMEM_EMBED_URL", SAVE.url]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("the default mode and mode=hybrid embed the query and return a meaning-only match; keyword does not", async () => {
    const store = new Store(":memory:");
    const client = await connect(store);
    for (const [title, body] of [["Infra", "API is deployed on Fly.io"], ["Meetings", "Weekly standup is on Monday"]]) {
      await client.callTool({ name: "state_write", arguments: { title, body } });
    }
    assert.equal(embedCalls.length, 2, "each saved note was embedded on write");
    const query = "where is the app hosted";

    const before = embedCalls.length;
    const byDefault = await search(client, { query });
    assert.ok(byDefault.results.some((n: any) => n.title === "Infra"), JSON.stringify(byDefault).slice(0, 300));
    assert.equal(embedCalls.length, before + 1, "the query was embedded once (default mode is hybrid when embeddings are on)");
    assert.equal(embedCalls[embedCalls.length - 1], query);

    const hybrid = await search(client, { query, mode: "hybrid" });
    assert.ok(hybrid.results.some((n: any) => n.title === "Infra"));

    const keyword = await search(client, { query, mode: "keyword" });
    assert.ok(!keyword.results.some((n: any) => n.title === "Infra"), "no shared word, so keyword search cannot find it");
    store.close();
  });

  test("with embeddings off, hybrid says so and returns keyword results (the paraphrase is not found)", async () => {
    process.env.MONOMEM_EMBEDDINGS = "off";
    const store = new Store(":memory:");
    const client = await connect(store);
    await client.callTool({ name: "state_write", arguments: { title: "Infra", body: "API is deployed on Fly.io" } });
    const r = await search(client, { query: "where is the app hosted", mode: "hybrid" });
    assert.equal(r.results.length, 0);
    assert.match(String(r.notice), /semantic search is not set up/);
    store.close();
  });
});

describe("reindex embedder: long first call and retries", () => {
  const cfg = { ...embeddingsConfig(), enabled: true, timeoutMs: 30_000 };
  const noSleep = async (): Promise<void> => undefined;

  test("the first call gets the long cold-model timeout, later ones the normal one", async () => {
    const seen: number[] = [];
    const f = reindexEmbedder(cfg, { embed: async (_t, c) => (seen.push(c!.timeoutMs), Float32Array.from([1])), sleep: noSleep });
    await f("a");
    await f("b");
    assert.deepEqual(seen, [COLD_FIRST_TIMEOUT_MS, 30_000]);
  });
  test("a failed (aborted) note is retried and then succeeds", async () => {
    let n = 0;
    const seen: number[] = [];
    const f = reindexEmbedder(cfg, { embed: async (_t, c) => (seen.push(c!.timeoutMs), ++n < 3 ? null : Float32Array.from([1])), sleep: noSleep });
    assert.ok(await f("a"));
    assert.equal(n, 3);
    assert.deepEqual(seen, [COLD_FIRST_TIMEOUT_MS, RETRY_TIMEOUT_MS, RETRY_TIMEOUT_MS]);
  });
  test("a note that keeps failing is given up after three tries, and the next note still runs", async () => {
    let n = 0;
    const f = reindexEmbedder(cfg, { embed: async (t) => (++n, t === "bad" ? null : Float32Array.from([1])), sleep: noSleep });
    assert.equal(await f("bad"), null);
    assert.equal(n, 3);
    assert.ok(await f("good"));
  });
  test("pauses between tries are short and bounded", async () => {
    const slept: number[] = [];
    const f = reindexEmbedder(cfg, { embed: async () => null, sleep: async (ms) => void slept.push(ms) });
    await f("x");
    assert.deepEqual(slept, [2000, 5000]);
  });
});
