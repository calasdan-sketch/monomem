// 1.5.0 (round 2, U-10): /health says which build and schema the server runs, and doctor warns when a running server is
// older than this CLI (an upgrade without a restart: the old process keeps writing in the old shape).
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  test("/health on both servers returns {status, version, schema}", async () => {
    const store = new Store(":memory:");
    for (const server of [createApiServer(store, "tok-admin-1234567890"), createMcpHttpServer(store, "tok-admin-1234567890")]) {
      await new Promise<void>((r) => server.listen(0, r));
      try {
        const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`)).json();
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
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, MONOMEM_HOME: join(dir, "data"), MONOMEM_PORT: String((fake.address() as AddressInfo).port) };
    try {
      let out = await runDoctor(env);
      assert.match(out, /\[warn\].*server .* is older .*restart/i, out);
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
});
