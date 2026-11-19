// 1.5.0 (round 2, U-10): /health says which build and schema the server runs, and doctor warns when a running server is
// older than this CLI (an upgrade without a restart: the old process keeps writing in the old shape).
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { createMcpHttpServer } from "../src/mcp-http.js";
import { PACKAGE_VERSION } from "../src/config.js";
import { ensureKey } from "../src/crypto.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runDoctor(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((r) => {
    const c = spawn(process.execPath, ["--no-warnings", CLI, "doctor"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("exit", () => r(out));
  });
}

describe("version handshake (U-10)", () => {
  test("/health on both servers: {status} only without a key (or with a wrong one), {status, version, schema} with a valid key", async () => {
    const store = new Store(":memory:");
    for (const server of [createApiServer(store, "tok-admin-1234567890"), createMcpHttpServer(store, "tok-admin-1234567890")]) {
      await new Promise<void>((r) => server.listen(0, r));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
        assert.deepEqual(await (await fetch(url)).json(), { status: "ok" });
        assert.deepEqual(await (await fetch(url, { headers: { authorization: "Bearer not-the-key-0123456789" } })).json(), { status: "ok" });
        const body = await (await fetch(url, { headers: { authorization: "Bearer tok-admin-1234567890" } })).json();
        assert.deepEqual(body, { status: "ok", version: PACKAGE_VERSION, schema: SCHEMA_VERSION });
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
    store.close();
  });

  test("doctor warns 'server is older: restart' when the running server is an older build; says nothing when it matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-handshake-"));
    let answer: Record<string, unknown> = { status: "ok" }; // a 1.4 server: no version at all
    const fake = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    mkdirSync(join(dir, "data")); // set up: doctor no longer creates a missing data folder (1.5.0 final panel)
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, MONOMEM_HOME: join(dir, "data"), MONOMEM_PORT: String((fake.address() as AddressInfo).port), MONOMEM_NO_SERVER_PROBE: "" };
    try {
      let out = await runDoctor(env);
      assert.match(out, /\[warn\].*server .* did not report its version.*restart/i, out);
      answer = { status: "ok", version: "1.4.0", schema: SCHEMA_VERSION - 1 };
      out = await runDoctor(env);
      assert.match(out, /\[warn\].*server .*1\.4\.0.* is older .*restart/i, out);
      answer = { status: "ok", version: PACKAGE_VERSION, schema: SCHEMA_VERSION };
      out = await runDoctor(env);
      assert.doesNotMatch(out, /is older/);
      assert.match(out, new RegExp(`\\[ok\\].*server .*${PACKAGE_VERSION.replace(/\./g, "\\.")}`));
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("doctor shows the body index of a verified server for this encrypted store, and warns when searches fell back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-doctor-bi-"));
    const data = join(dir, "data");
    ensureKey(data);
    const TOKEN = "doctor-body-index-token-0123456789abcdef";
    const store = new Store(join(data, "state.db"), { bodyIndexMaxNotes: 1 });
    const srv = createApiServer(store, TOKEN);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, MONOMEM_HOME: data, MONOMEM_TOKEN: TOKEN, MONOMEM_PORT: String((srv.address() as AddressInfo).port), MONOMEM_NO_SERVER_PROBE: "" };
    try {
      store.create({ title: "one", body: "sealed words", tags: [] });
      store.warmBodyIndex();
      const out = await runDoctor(env);
      assert.match(out, /\[ok\].*server body search index: ready \(1 notes indexed, 0 bodies unreadable, 0 searches/, out);
      // A new server answers an unauthenticated /health with {status} only: doctor still learns the version, because the server
      // proved it holds this key and store, and then /status carries it.
      assert.match(out, new RegExp(`\\[ok\\].*server on port \\d+ runs ${PACKAGE_VERSION.replace(/\./g, "\\.")}`), out);
      store.create({ title: "two", body: "more sealed words", tags: [] });
      store.close();
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    // A server started on a store over its cap (here 1 note): every search is on titles and tags only, and doctor says so.
    const capped = new Store(join(data, "state.db"), { bodyIndexMaxNotes: 1 });
    const srv2 = createApiServer(capped, TOKEN);
    await new Promise<void>((r) => srv2.listen(0, "127.0.0.1", r));
    try {
      capped.searchRanked("sealed");
      const out = await runDoctor({ ...env, MONOMEM_PORT: String((srv2.address() as AddressInfo).port) });
      assert.match(out, /\[warn\].*server body search index: too large .*[1-9]\d* searches on titles and tags only.*not built above 1 notes/, out);
    } finally {
      await new Promise<void>((r) => srv2.close(() => r()));
      capped.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
