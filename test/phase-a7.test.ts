// Phase A7: performance and reliability (background index build, list index, host check, connection limits,
// backup without the key, recall markers, import cap, Docker files).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { hostAllowed } from "../src/security.js";
import { IMPORT_BODY_BYTES } from "../src/http-common.js";
import { backupStore } from "../src/backup.js";
import { ensureKey } from "../src/crypto.js";
import { indexLine } from "../src/context-inject.js";
import { UNTRUSTED_REMINDER, runRecall } from "../src/recall.js";
import { actorStore } from "../src/actor.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("A7: a big namespace is indexed in the background, not inside the write", () => {
  test("above MONOMEM_EDGE_SYNC_MAX the first write does not build the index; it is built shortly after and the waiting note is linked", async () => {
    process.env.MONOMEM_EDGE_SYNC_MAX = "5";
    const s = new Store(":memory:");
    const db = (s as unknown as { db: { exec(sql: string): void } }).db;
    // Notes inserted behind the store's back, so no index exists yet (like a database opened fresh).
    for (let i = 0; i < 20; i++) {
      db.exec(`INSERT INTO notes (namespace, title, body, tags, created_at, updated_at) VALUES ('big', 'deploy server ${i}', 'staging deploy server port 8443 note ${i}', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    }
    const n = s.create({ namespace: "big", title: "deploy server staging", body: "staging deploy server port 8443 again" });
    assert.deepEqual(s.cachedEdgeIndexes(), [], "the write returned without tokenizing the whole namespace");
    assert.equal(s.listNeighbors(n.id).length, 0, "no links yet");
    await sleep(300);
    assert.ok(s.cachedEdgeIndexes().includes("big"), "the index was built in the background");
    assert.ok(s.listNeighbors(n.id).length > 0, "and the note that was waiting got its links");
    s.close();
  });

  test("a namespace over MONOMEM_EDGE_AUTO_MAX_NOTES is never indexed automatically", async () => {
    process.env.MONOMEM_EDGE_SYNC_MAX = "2";
    process.env.MONOMEM_EDGE_AUTO_MAX_NOTES = "5";
    const s = new Store(":memory:");
    const db = (s as unknown as { db: { exec(sql: string): void } }).db;
    for (let i = 0; i < 10; i++) {
      db.exec(`INSERT INTO notes (namespace, title, body, tags, created_at, updated_at) VALUES ('huge', 'deploy ${i}', 'staging deploy server port ${i}', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    }
    const n = s.create({ namespace: "huge", title: "deploy again", body: "staging deploy server port 1" });
    await sleep(200);
    assert.deepEqual(s.cachedEdgeIndexes(), []);
    assert.equal(s.listNeighbors(n.id).length, 0);
    assert.ok(s.read(n.id), "the note itself is stored normally");
    s.close();
  });

  test("a small namespace is still indexed straight away (unchanged behaviour)", () => {
    const s = new Store(":memory:");
    s.create({ title: "deploy server", body: "staging deploy server port 8443" });
    const n = s.create({ title: "deploy server again", body: "staging deploy server port 8443 again" });
    assert.ok(s.cachedEdgeIndexes().includes("default"));
    assert.ok(s.listNeighbors(n.id).length > 0);
    s.close();
  });
});

describe("A7: the default list is served from an index", () => {
  test("both list orders use an index and no temporary sort", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 30; i++) s.create({ title: "t" + i, body: "b" + i });
    const db = (s as unknown as { db: { prepare(sql: string): { all(): Array<{ detail: string }> } } }).db;
    for (const sql of [
      "SELECT * FROM notes WHERE archived_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 50",
      "SELECT * FROM notes WHERE namespace = 'default' AND archived_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT 50",
    ]) {
      const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all().map((r) => r.detail).join(" | ");
      assert.match(plan, /idx_notes_(live|ns)_updated/, plan);
      assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
    }
    s.close();
  });
});

describe("A7: host check and connection limits", () => {
  const req = (host: string | undefined, extra: Record<string, string> = {}): IncomingMessage =>
    ({ headers: { ...(host === undefined ? {} : { host }), ...extra } }) as unknown as IncomingMessage;

  test("localhost, IP addresses and proxied requests pass; a stray host name is refused", () => {
    assert.equal(hostAllowed(req("localhost:8790")), true);
    assert.equal(hostAllowed(req("127.0.0.1:8790")), true);
    assert.equal(hostAllowed(req("[::1]:8790")), true);
    assert.equal(hostAllowed(req("192.168.1.20:8790")), true, "a LAN address (Docker, NAS) keeps working");
    assert.equal(hostAllowed(req(undefined)), true);
    assert.equal(hostAllowed(req("evil.example")), false);
    assert.equal(hostAllowed(req("attacker.test:8790")), false);
    assert.equal(hostAllowed(req("monomem.mydomain.com", { "x-forwarded-for": "1.2.3.4" })), false, "a forwarding header the caller sends proves nothing");
    assert.equal(hostAllowed(req("evil.example", { "x-real-ip": "1.2.3.4" })), false);
    process.env.MONOMEM_TRUST_PROXY = "1";
    assert.equal(hostAllowed(req("monomem.mydomain.com", { "x-forwarded-for": "1.2.3.4" })), true, "opt-in only");
    delete process.env.MONOMEM_TRUST_PROXY;
  });

  test("MONOMEM_ALLOWED_HOSTS adds names and makes the check strict", () => {
    process.env.MONOMEM_ALLOWED_HOSTS = "mynas.local, Monomem.Example.com:443";
    assert.equal(hostAllowed(req("mynas.local:8790")), true);
    assert.equal(hostAllowed(req("monomem.example.com")), true);
    assert.equal(hostAllowed(req("other.example")), false);
    assert.equal(hostAllowed(req("other.example", { "x-forwarded-for": "1.2.3.4" })), false, "strict once configured");
    assert.equal(hostAllowed(req("localhost")), true);
  });

  test("the API refuses a stray Host with a hint, answers /health regardless, and sets explicit limits", async () => {
    const s = new Store(":memory:");
    const server = createApiServer(s, [{ token: "k".repeat(40), scope: "admin", label: "op" }]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    assert.equal(server.maxConnections, 512);
    assert.equal(server.headersTimeout, 20_000);
    assert.equal(server.requestTimeout, 300_000);
    const get = (path: string, host: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        }).on("error", reject);
      });
    const bad = await get("/", "evil.example");
    assert.equal(bad.status, 403);
    assert.match(bad.body, /MONOMEM_ALLOWED_HOSTS=evil\.example/);
    assert.equal((await get("/", `127.0.0.1:${port}`)).status, 200);
    assert.equal((await get("/health", "evil.example")).status, 200, "the liveness probe never depends on the name");
    await new Promise<void>((r) => server.close(() => r()));
    s.close();
  });

  test("the limits can be changed with environment variables", async () => {
    process.env.MONOMEM_MAX_CONNECTIONS = "7";
    process.env.MONOMEM_HEADERS_TIMEOUT_MS = "1234";
    const s = new Store(":memory:");
    const server = createApiServer(s, [{ token: "k".repeat(40), scope: "admin", label: "op" }]);
    assert.equal(server.maxConnections, 7);
    assert.equal(server.headersTimeout, 1234);
    server.close();
    s.close();
  });
});

describe("A7: backups do not carry the encryption key unless asked", () => {
  test("default leaves .key out and says where it is; --include-key copies it", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-a7-bk-"));
    try {
      ensureKey(dir);
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "n", body: "sealed" });
      const plain = backupStore(s, db, join(dir, "b1"));
      assert.equal(plain.key, null);
      assert.equal(existsSync(join(dir, "b1", ".key")), false);
      assert.equal(plain.keyLeftOut, join(dir, ".key"));
      assert.match(readFileSync(join(dir, "b1", "README.txt"), "utf8"), /key is NOT in this folder/);
      const withKey = backupStore(s, db, join(dir, "b2"), { includeKey: true });
      assert.ok(withKey.key && existsSync(withKey.key));
      assert.equal(withKey.keyLeftOut, null);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A7: recall marks who wrote each line and ends with a reminder", () => {
  test("an index line names the writer; the hook output ends with the untrusted-data reminder", async () => {
    const s = new Store(":memory:");
    const n = actorStore.run({ label: "cursor", authed: true }, () => s.create({ title: "port is 8443", body: "staging" }));
    const line = indexLine(s.read(n.id)!);
    assert.match(line, /\bby /);
    s.close();
    const dir = mkdtempSync(join(tmpdir(), "om-a7-rc-"));
    try {
      const db = join(dir, "state.db");
      const s2 = new Store(db);
      s2.create({ title: "remember this", body: "staging port 8443" });
      s2.close();
      const out = await runRecall({ dbPath: db, cwd: dir });
      const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
      assert.ok(ctx.length > 0);
      assert.ok(ctx.trimEnd().endsWith(UNTRUSTED_REMINDER), ctx.slice(-200));
      assert.match(ctx, /UNTRUSTED DATA/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("A7: import cap and Docker files", () => {
  test("the restore body cap defaults to 64 MB", () => {
    assert.equal(IMPORT_BODY_BYTES, 64 * 1024 * 1024);
  });
  test("Dockerfile pins the image by version and digest and checks both ports; compose is locked down", () => {
    const d = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    assert.doesNotMatch(d, /FROM node:24-alpine\b(?!\.)/);
    assert.equal((d.match(/FROM node:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}/g) ?? []).length, 2);
    assert.match(d, /8790\/ready/);
    assert.match(d, /8791\/health/);
    const c = readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8");
    for (const k of ["read_only: true", "cap_drop:", "- ALL", "mem_limit:", "no-new-privileges", "healthcheck:", "8791/health"]) assert.ok(c.includes(k), k);
  });
  test("the roadmap and the new settings are written down", () => {
    const sec = readFileSync(join(process.cwd(), "SECURITY.md"), "utf8");
    assert.match(sec, /one-way hashes/);
    assert.match(sec, /key rotation/i);
    const cfg = readFileSync(join(process.cwd(), "docs/configuration.md"), "utf8");
    for (const k of ["MONOMEM_ALLOWED_HOSTS", "MONOMEM_MAX_CONNECTIONS", "MONOMEM_EDGE_SYNC_MAX", "MONOMEM_EDGE_AUTO_MAX_NOTES", "MONOMEM_HEADERS_TIMEOUT_MS", "MONOMEM_REQUEST_TIMEOUT_MS", "MONOMEM_KEEPALIVE_TIMEOUT_MS", "MONOMEM_EDGE_SLICE_MS"]) assert.ok(cfg.includes(k), k);
  });
});
