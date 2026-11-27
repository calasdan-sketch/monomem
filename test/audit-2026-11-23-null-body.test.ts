// Security audit 2026-11-23: a JSON body of `null` (valid JSON) must never reach a handler as null. Before the fix every route
// that does JSON.parse(raw || "{}") and then reads a property answered 500 "internal error" (a TypeError), not a 400.
import "./setup-env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";

const TOKEN = "audit-null-body-token-0123456789abcdef";
const ROUTES: Array<[string, string]> = [
  ["POST", "/notes"], ["PUT", "/notes/1"], ["POST", "/notes/1/confirm"], ["POST", "/notes/1/flag"], ["POST", "/relevant"], ["POST", "/get"],
  ["POST", "/capture"], ["POST", "/tasks"], ["POST", "/handoffs"], ["POST", "/ack"], ["POST", "/tokens"], ["PUT", "/approve-first"],
  ["PUT", "/pinned"], ["POST", "/flood/resume"], ["POST", "/trust/distrust"], ["POST", "/trust/attesters"], ["POST", "/trust/revoked"],
  ["POST", "/rollback/preview"], ["POST", "/rollback/confirm"], ["POST", "/login"], ["POST", "/import"], ["POST", "/hook"], ["POST", "/tasks/1/claim"],
];

describe("null and non-object JSON bodies are a 400, never a 500", () => {
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  before(async () => {
    store = new Store(":memory:");
    server = createApiServer(store, TOKEN);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  for (const [method, path] of ROUTES) {
    test(`${method} ${path} with body null`, async () => {
      const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: "null" });
      await res.text();
      assert.ok(res.status < 500, `${method} ${path} answered ${res.status}`);
    });
  }
});
