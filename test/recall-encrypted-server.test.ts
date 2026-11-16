import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// 1.5.0: on an encrypted store the session-start hook matches titles and tags itself (it never builds the in-memory body
// index). A Monomem server for the SAME store running on loopback has that index: the hook asks it for body matches
// within a short time budget, and falls back to title-and-tag matching when there is no server, a slow one, or one that
// cannot prove it holds this store's main key.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { createApiServer } from "../src/api.js";
import { runRecall, SERVER_ASK_MS } from "../src/recall.js";

const TOKEN = "recall-encrypted-server-test-token-0123456789abcdef";
const contextOf = (hookJson: string): string => JSON.parse(hookJson).hookSpecificOutput.additionalContext as string;

/** An encrypted store: one old note whose BODY alone holds "zephyrcanyon", then 150 newer notes that fill the recency pool. */
function seed(): { dir: string; db: string; target: number } {
  const dir = mkdtempSync(join(tmpdir(), "om-recall-srv-"));
  ensureKey(dir);
  const db = join(dir, "state.db");
  const s = new Store(db, { bodyIndex: "off" });
  try {
    const target = s.create({ title: "Old deploy notes", body: "the release runs from the zephyrcanyon region", tags: [] }, { lint: "none" }).id;
    s.transaction(() => {
      for (let i = 0; i < 150; i++) s.create({ title: `filler ${i}`, body: `nothing to see ${i}`, tags: [] }, { skipEdges: true, lint: "none" });
    });
    assert.ok(s.encryptedCount() > 0, "bodies are sealed");
    return { dir, db, target };
  } finally {
    s.close();
  }
}

const listen = (srv: Server): Promise<number> => new Promise((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
const close = (srv: Server): Promise<void> => new Promise((r) => srv.close(() => r()));
const signals = { branch: "zephyrcanyon", diffFiles: [] };

describe("session start on an encrypted store asks a local server for body matches", () => {
  // The hook reads the main key from MONOMEM_TOKEN (else the .token file); every case has one, so every case really asks.
  before(() => (process.env.MONOMEM_TOKEN = TOKEN));
  after(() => delete process.env.MONOMEM_TOKEN);
  test("a server for the same store: a body-only word reaches session start", async () => {
    const { dir, db, target } = seed();
    const serverStore = new Store(db);
    serverStore.warmBodyIndex();
    const srv = createApiServer(serverStore, TOKEN);
    try {
      const port = await listen(srv);
      // This checks the answer, not the clock: the server runs in this same process, so on a loaded CI machine it can miss
      // the 300 ms budget and session start correctly falls back (the never-answers case below checks that budget).
      const ctx = contextOf(await runRecall({ dbPath: db, cwd: dir, signals, serverPort: port, serverAskMs: 5000 }));
      // An empty context means session start's 5 s cap fired (a loaded machine), not a wrong match: say so plainly.
      assert.notEqual(ctx, "", "session start returned no context: its 5 s cap fired before the notes were read");
      assert.match(ctx, new RegExp(`#${target}\\b[^\\n]*Old deploy notes[^\\n]*\\{[^}]*kw`), ctx);
    } finally {
      await close(srv);
      serverStore.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  test("no server: title-and-tag matching as before, well inside the budget", async () => {
    const { dir, db, target } = seed();
    const free = createServer();
    const port = await listen(free);
    await close(free); // a port nothing listens on
    try {
      // "No server costs almost nothing", measured against the same session start with no server probe at all (a fixed
      // 800 ms failed on a loaded Windows runner where session start itself took longer).
      process.env.MONOMEM_NO_SERVER_PROBE = "1";
      const t1 = Date.now();
      await runRecall({ dbPath: db, cwd: dir, signals });
      const base = Date.now() - t1;
      delete process.env.MONOMEM_NO_SERVER_PROBE;
      const t0 = Date.now();
      const ctx = contextOf(await runRecall({ dbPath: db, cwd: dir, signals, serverPort: port }));
      const took = Date.now() - t0;
      assert.ok(took < base + 500, `no server took ${took} ms; session start without asking took ${base} ms`);
      assert.doesNotMatch(ctx, new RegExp(`#${target}\\b`), "the body-only note is not found without the server");
      assert.match(ctx, /filler/, "the rest of session start is unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  test("a server that never answers costs at most the ask budget", async () => {
    const { dir, db, target } = seed();
    let asked = 0;
    const hang = createServer(() => {
      asked++; // never responds
    });
    const port = await listen(hang);
    try {
      const t0 = Date.now();
      const ctx = contextOf(await runRecall({ dbPath: db, cwd: dir, signals, serverPort: port }));
      assert.ok(Date.now() - t0 < SERVER_ASK_MS + 600, `took ${Date.now() - t0} ms`);
      assert.equal(asked, 1, "the hook did ask, then gave up");
      assert.doesNotMatch(ctx, new RegExp(`#${target}\\b`));
    } finally {
      hang.closeAllConnections();
      await close(hang);
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });

  test("a program that cannot prove it holds this store's key never receives the key", async () => {
    const { dir, db } = seed();
    const seen: string[] = [];
    const fake = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ proof: "0".repeat(64), results: [] }));
    });
    const port = await listen(fake);
    // A real Monomem server for ANOTHER store with the same key fails the proof too (the store id is part of it).
    const otherDir = mkdtempSync(join(tmpdir(), "om-recall-other-"));
    const other = new Store(join(otherDir, "state.db"));
    const otherSrv = createApiServer(other, TOKEN);
    const otherPort = await listen(otherSrv);
    try {
      await runRecall({ dbPath: db, cwd: dir, signals, serverPort: port });
      assert.ok(seen.length > 0, "the hook asked");
      assert.ok(seen.every((l) => !l.includes(TOKEN)), `the key was sent to a program that could not prove itself: ${seen.join(" | ")}`);
      const ctx = contextOf(await runRecall({ dbPath: db, cwd: dir, signals, serverPort: otherPort }));
      assert.doesNotMatch(ctx, /Old deploy notes[^\n]*kw/);
    } finally {
      await close(fake);
      await close(otherSrv);
      other.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      rmSync(otherDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  });
});
