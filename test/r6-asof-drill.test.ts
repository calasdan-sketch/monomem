// Round 6: time-travel output, drill/health make no network call, MONOMEM_LINT typo hint, REST PUT of a whole note.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { asOfView, asOfFields, asOfHeader, localTimeOffset } from "../src/asof.js";
import { runDrill, renderDrill } from "../src/drill.js";
import { runHealth } from "../src/health.js";
import { lintDidYouMean } from "../src/lint.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mark = async (): Promise<Date> => {
  await sleep(5);
  const d = new Date();
  await sleep(5);
  return d;
};

describe("time travel output", () => {
  test("an edited note drops today's confidence and attestation claims; header has seconds and the archived count", async () => {
    const store = new Store(":memory:");
    const n = as("alice", () => store.create({ title: "plan", body: "one", confidence: 0.9 }));
    const gone = as("alice", () => store.create({ title: "gone", body: "x" }));
    await sleep(5);
    store.archive(gone.id);
    const t = await mark();
    as("bob", () => store.update(n.id, { body: "two", confidence: 0.1 }));
    const view = asOfView(store, t);
    assert.equal(view.archivedThen, 1);
    const f = asOfFields(view.notes[0], (x) => ({ ...x, writer_id: "srv/bob", attested_writer: "bob", confidence_claimed_by: "bob" }));
    for (const k of ["confidence", "confidence_claimed_by", "writer_id", "attested_writer", "attested_by"]) assert.equal(k in f, false, k);
    assert.match(localTimeOffset(t), /\d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
    const h = asOfHeader(view);
    assert.match(h, /1 note was archived or replaced then and is not shown/);
    assert.match(h, /Memory as of \d{4}-\d\d-\d\d \d\d:\d\d:\d\d /);
  });
});

describe("drill and health make no network call", () => {
  test("with embeddings on and a remote URL, neither fetches it or logs a failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r6-nonet-"));
    const db = join(dir, "state.db");
    const s = new Store(db);
    for (let i = 0; i < 5; i++) s.create({ title: `note ${i}`, body: `body ${i}` });
    s.close();
    const realFetch = globalThis.fetch;
    const outside: string[] = [];
    // own temp root, so the drill test file running in parallel never sees this drill's copy folder
    const env = { MONOMEM_EMBEDDINGS: process.env.MONOMEM_EMBEDDINGS, MONOMEM_EMBED_URL: process.env.MONOMEM_EMBED_URL, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = dir;
    const realErr = console.error;
    const errs: string[] = [];
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    process.env.MONOMEM_EMBEDDINGS = "on";
    process.env.MONOMEM_EMBED_URL = "https://embed.example.invalid/v1/embeddings";
    // the drill's own server is on 127.0.0.1 and passes through; anything else is counted and refused
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const u = String(input instanceof Request ? input.url : input);
      if (/^https?:\/\/127\.0\.0\.1[:/]/.test(u)) return realFetch(input as string, init as RequestInit);
      outside.push(u);
      return Promise.reject(new Error("no network in tests"));
    }) as typeof fetch;
    try {
      const d = await runDrill({ dbPath: db });
      assert.match(renderDrill(d), /Embeddings (?:were )?off for the (?:drill|replay)/);
      assert.equal(process.env.MONOMEM_EMBEDDINGS, "on", "the setting is restored");
      await runHealth({ dbPath: db, auditPath: join(dir, "audit.log"), settingsPath: join(dir, "none.json"), pluginsPath: join(dir, "none2.json") });
    } finally {
      globalThis.fetch = realFetch;
      console.error = realErr;
      for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
    assert.deepEqual(outside, []);
    assert.deepEqual(errs.filter((e) => /embed/i.test(e)), []);
  });
});

describe("MONOMEM_LINT typo", () => {
  test("a near miss gets a did-you-mean; an unrelated value gets none", () => {
    assert.match(lintDidYouMean("quaratine"), /"quaratine": did you mean quarantine\?/);
    assert.match(lintDidYouMean("secrets=wran,injection=block"), /did you mean warn\?/);
    assert.equal(lintDidYouMean("zzzzzzzz"), "");
  });

  test("correctly spelled values give no hint", () => {
    for (const ok of ["secrets=block,injection=quarantine", "pii=quarantine", "secrets=warn, injection=warn", "quarantine", "entropy=warn,directive=quarantine"]) {
      assert.equal(lintDidYouMean(ok), "", ok);
    }
  });
});

describe("REST PUT of a whole note", () => {
  test("read-only response fields are ignored; if_rev still works; unknown fields still 400", async () => {
    const store = new Store(":memory:");
    const server = createApiServer(store, "tok");
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (method: string, path: string, body?: unknown) =>
      fetch(base + path, { method, headers: { Authorization: "Bearer tok", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      const made: any = ((await (await call("POST", "/notes", { title: "t", body: "one" })).json()) as any).note;
      const got: any = ((await (await call("GET", `/notes/${made.id}`)).json()) as any).note;
      const put = await call("PUT", `/notes/${made.id}`, { ...got, body: "two", rev: 999, written_by: "forged", created_at: "2000-01-01T00:00:00Z" });
      assert.equal(put.status, 200, JSON.stringify(await put.clone().json()));
      const after: any = ((await (await call("GET", `/notes/${made.id}`)).json()) as any).note;
      assert.equal(after.body, "two");
      assert.notEqual(after.written_by, "forged");
      assert.notEqual(after.created_at, "2000-01-01T00:00:00Z");
      assert.equal((await call("PUT", `/notes/${made.id}`, { body: "x", if_rev: 1 })).status, 409, "stale if_rev still refused");
      const bad = await call("PUT", `/notes/${made.id}`, { content: "x" });
      assert.equal(bad.status, 400);
      assert.match(((await bad.json()) as any).error, /unknown field: content/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});
