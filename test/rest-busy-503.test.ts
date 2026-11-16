// 1.5.0 (round 2, infra HIGH-1): a write that can't get the database lock answers 503 + Retry-After, not a bare 500.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";

describe("REST busy database", () => {
  test("a write blocked by another program's lock gets 503 with Retry-After and a plain message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-busy-"));
    const path = join(dir, "t.db");
    const store = new Store(path, { busyTimeoutMs: 200 });
    const other = new DatabaseSync(path);
    const server = createApiServer(store, "tok-admin-1234567890");
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      other.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
      const res = await fetch(`${base}/notes`, {
        method: "POST",
        headers: { Authorization: "Bearer tok-admin-1234567890", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "blocked", body: "x" }),
      });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "2");
      assert.match(((await res.json()) as any).error, /busy.*nothing was saved/i);
    } finally {
      other.exec("ROLLBACK");
      other.close();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
