// Security audit 2026-11-23: a client that has not signed in must not be able to hold a connection open by sending a request
// body (POST /login, OAuth registration) slowly. 600 such sockets filled MONOMEM_MAX_CONNECTIONS (512) and a valid client got
// connection failures. Pre-auth bodies now have a small cap and an idle timeout.
import "./setup-env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";

const TOKEN = "audit-preauth-token-0123456789abcdef";

describe("pre-auth request bodies", () => {
  let store: Store;
  let server: ReturnType<typeof createApiServer>;
  let port: number;
  before(async () => {
    process.env.MONOMEM_PREAUTH_BODY_TIMEOUT_MS = "300"; // read per request, so setting it here is enough
    store = new Store(":memory:");
    server = createApiServer(store, TOKEN);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    store.close();
  });

  test("a slow POST /login body is cut off by the idle timeout", async () => {
    const closedAfterMs = await new Promise<number>((resolve) => {
      const t0 = Date.now();
      const s = net.connect(port, "127.0.0.1");
      s.on("error", () => {});
      s.on("close", () => resolve(Date.now() - t0));
      s.write(`POST /login HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"code":`);
      setTimeout(() => { s.destroy(); resolve(-1); }, 4000);
    });
    assert.ok(closedAfterMs >= 0 && closedAfterMs < 3000, `socket stayed open (${closedAfterMs})`);
  });

  test("a POST /login body over 4KB is refused with 413", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "a".repeat(5000) }) });
    assert.equal(res.status, 413);
  });

  test("a normal login attempt still answers 401 (bad code)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "0".repeat(32) }) });
    assert.equal(res.status, 401);
  });
});
