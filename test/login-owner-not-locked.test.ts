// 31-M7 / 30-F6: wrong /login codes from a shared address (a tunnel, no proxy declared) must not refuse the owner's right code.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { mintLoginCode } from "../src/login-code.js";

test("after 8+ wrong codes the key is locked for wrong guesses, but the right code still signs in", async () => {
  const store = new Store(":memory:");
  const server = createApiServer(store, "login-owner-token-0123456789abcdef");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`;
  const post = (code: string): Promise<Response> => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  try {
    for (let i = 0; i < 9; i++) await post("0".repeat(31) + String(i));
    assert.equal((await post("1".repeat(32))).status, 429, "the stranger is limited");
    const code = mintLoginCode();
    assert.equal((await post(code)).status, 200, "the owner is not");
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    store.close();
  }
});
