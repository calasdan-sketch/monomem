// r2-improvement #5: the flood guard stops agents, never the owner's own main key (the dashboard uses it).
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { setProcessWriter } from "../src/actor.js";

test("the main key (primary) is never paused; another admin key is, and the main key can resume it over REST", async () => {
  const prev = process.env.MONOMEM_FLOOD_WRITES_PER_HOUR;
  process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "3";
  const store = new Store(":memory:");
  setProcessWriter("server");
  const P = { token: "p".repeat(40), scope: "admin" as const, label: "primary" };
  const A = { token: "a".repeat(40), scope: "admin" as const, label: "bot-admin" };
  const http = createApiServer(store, [P, A]);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const call = async (tok: string, method: string, path: string, b?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < 8; i++) assert.equal((await call(P.token, "POST", "/notes", { title: `owner ${i}`, body: "x" })).status, 201);
    assert.deepEqual(store.pausedWriters(), []);
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await call(A.token, "POST", "/notes", { title: `bot ${i}`, body: "x" })).status;
    assert.notEqual(last, 201);
    assert.deepEqual(store.pausedWriters(), ["bot-admin"]);
    const r = await call(P.token, "POST", "/flood/resume", { writer: "bot-admin" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(store.pausedWriters(), []);
  } finally {
    console.error = quiet;
    if (prev === undefined) delete process.env.MONOMEM_FLOOD_WRITES_PER_HOUR;
    else process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = prev;
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    store.close();
    setProcessWriter("");
  }
});
