// 1.5.0 (round 2, U-12 / infra MED-5): a server started in the background (`monomem open`, a service) has no terminal, so
// `start --log` appends what it prints to <data>/server.log, rotated like audit.log (MONOMEM_AUDIT_MAX_BYTES / _KEEP).
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const TOKEN = "server-log-token-".padEnd(40, "x");

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => r(p));
    });
  });
}

describe("server.log (U-12)", () => {
  test("start --log with no terminal writes its output and a busy error to <data>/server.log, and rotates an oversized log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-srvlog-"));
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    const log = join(data, "server.log");
    writeFileSync(log, "old line\n".repeat(200)); // 1800 bytes, over the 1000-byte cap below
    const [api, mcp] = [await freePort(), await freePort()];
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, MONOMEM_HOME: data, MONOMEM_TOKEN: TOKEN, MONOMEM_PORT: String(api), MONOMEM_MCP_PORT: String(mcp), MONOMEM_AUDIT_MAX_BYTES: "1000" };
    const child = spawn(process.execPath, ["--no-warnings", CLI, "start", "--log"], { env, stdio: "ignore", windowsHide: true });
    let other: DatabaseSync | undefined;
    try {
      const deadline = Date.now() + 20_000;
      const text = (): string => (existsSync(log) ? readFileSync(log, "utf8") : "");
      while (!/MCP over HTTP/.test(text())) {
        assert.ok(Date.now() < deadline, "no startup lines in server.log: " + text().slice(0, 500));
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(existsSync(log + ".1"), "the oversized log was rotated to server.log.1");
      assert.doesNotMatch(text(), /old line/);
      assert.match(text(), /^\d{4}-\d\d-\d\dT\S+ \[monomem\] API \+ dashboard/m, "lines are timestamped");
      other = new DatabaseSync(join(data, "state.db"));
      other.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
      const res = await fetch(`http://127.0.0.1:${api}/notes`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "t", body: "b" }) });
      assert.equal(res.status, 503);
      await new Promise((r) => setTimeout(r, 200));
      assert.match(text(), /write gave up waiting for the database lock/);
    } finally {
      try {
        other?.exec("ROLLBACK");
        other?.close();
      } catch {
        /* released */
      }
      child.kill();
      await new Promise((r) => child.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
