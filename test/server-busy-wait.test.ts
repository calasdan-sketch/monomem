// 1.5.0 (round 2, U-09 / infra HIGH-1): node:sqlite waits for a lock on the event loop, so the HTTP server's busy wait is
// short (2 s). Another program holding the write lock for 10 s must not freeze the server: a REST write answers 503 in
// under 3 s, /health in under 3.5 s, and an MCP write gets a clear "busy, retry" tool error in under 3 s.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const TOKEN = "busy-wait-token-".padEnd(40, "x");

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

async function timed<T>(f: () => Promise<T>): Promise<{ ms: number; v: T }> {
  const t = Date.now();
  const v = await f();
  return { ms: Date.now() - t, v };
}

describe("HTTP server busy wait (U-09)", () => {
  test("lock held 10 s by another program: REST 503 < 3 s, /health < 3.5 s, MCP busy tool error < 3 s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-busywait-"));
    const [api, mcp] = [await freePort(), await freePort()];
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, MONOMEM_HOME: join(dir, "data"), MONOMEM_TOKEN: TOKEN, MONOMEM_PORT: String(api), MONOMEM_MCP_PORT: String(mcp) };
    const child = spawn(process.execPath, ["--no-warnings", CLI, "start"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    let other: DatabaseSync | undefined;
    try {
      const deadline = Date.now() + 20_000;
      while (!/MCP over HTTP/.test(err) || !/API \+ dashboard/.test(err)) {
        assert.ok(Date.now() < deadline, "server did not start: " + err);
        await new Promise((r) => setTimeout(r, 100));
      }
      other = new DatabaseSync(join(dir, "data", "state.db"));
      other.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
      const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
      const write = timed(() => fetch(`http://127.0.0.1:${api}/notes`, { method: "POST", headers: auth, body: JSON.stringify({ title: "blocked", body: "x" }) }));
      await new Promise((r) => setTimeout(r, 100)); // the write is now waiting on the lock
      const health = await timed(() => fetch(`http://127.0.0.1:${api}/health`));
      const w = await write;
      assert.equal(w.v.status, 503);
      assert.ok(w.ms < 3000, `REST write took ${w.ms} ms`);
      assert.equal(health.v.status, 200);
      assert.ok(health.ms < 3500, `/health took ${health.ms} ms`);

      const m = await timed(() =>
        fetch(`http://127.0.0.1:${mcp}/mcp`, {
          method: "POST",
          headers: { ...auth, Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "state_write", arguments: { title: "blocked", body: "x" } } }),
        }).then((r) => r.text())
      );
      assert.ok(m.ms < 3000, `MCP write took ${m.ms} ms`);
      assert.match(m.v, /isError/);
      assert.match(m.v, /busy.*try again/i, m.v);
      assert.doesNotMatch(m.v, /internal error/);
    } finally {
      try {
        other?.exec("ROLLBACK");
        other?.close();
      } catch {
        /* already released */
      }
      child.kill();
      await new Promise((r) => child.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
