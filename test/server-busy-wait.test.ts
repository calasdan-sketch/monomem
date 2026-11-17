// 1.5.0 (round 2, U-09 / infra HIGH-1): node:sqlite waits for a lock on the event loop, so the HTTP server's busy wait is
// short (2 s). Another program holding the write lock for 10 s must not freeze the server: a REST write answers 503 in
// within one lock wait, /health right after it, and an MCP write gets a clear "busy, retry" tool error within one wait.
// "One wait" is measured here, not assumed: SQLite's own 2 s busy wait takes about 2.3 s on Windows and Linux but about
// 4 s on GitHub's macOS runners (its many short sleeps overrun there), so each bound is under two of those measured waits,
// and all stay far under the Store's 20 s.
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
import { SERVER_BUSY_TIMEOUT_MS } from "../src/db-problem.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const TOKEN = "busy-wait-token-".padEnd(40, "x");

/** Wall time of one plain SQLite lock wait of SERVER_BUSY_TIMEOUT_MS on this machine (no Monomem code involved). */
function oneLockWaitMs(dir: string): number {
  const path = join(dir, "baseline.db");
  const holder = new DatabaseSync(path);
  const waiter = new DatabaseSync(path);
  try {
    holder.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    waiter.exec(`PRAGMA busy_timeout = ${SERVER_BUSY_TIMEOUT_MS};`);
    const t = Date.now();
    assert.throws(() => waiter.exec("BEGIN IMMEDIATE"), /locked|busy/i);
    return Date.now() - t;
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
    waiter.close();
  }
}

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
  test("lock held 10 s by another program: REST 503, /health and an MCP busy tool error each within one lock wait", async () => {
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
      const wait = oneLockWaitMs(dir);
      // Under two lock waits: catches a second wait or the Store's 20 s, without a fixed margin a slow runner overruns.
      const within = (ms: number): boolean => ms < wait * 1.8 && ms < 10_000;
      assert.equal(w.v.status, 503);
      assert.ok(within(w.ms), `REST write took ${w.ms} ms; one plain lock wait here takes ${wait} ms`);
      assert.equal(health.v.status, 200);
      assert.ok(within(health.ms), `/health took ${health.ms} ms; one plain lock wait here takes ${wait} ms`);

      const m = await timed(() =>
        fetch(`http://127.0.0.1:${mcp}/mcp`, {
          method: "POST",
          headers: { ...auth, Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "state_write", arguments: { title: "blocked", body: "x" } } }),
        }).then((r) => r.text())
      );
      assert.ok(within(m.ms), `MCP write took ${m.ms} ms; one plain lock wait here takes ${wait} ms`);
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
