// `monomem stop` (r3 ease S2): the background server `monomem open` starts has no window, so stop is the way to end it.
// A stand-in server (a tiny node process answering /health) plays the background server: no real Monomem server is
// started and no browser is opened.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config.js";
import { pidFile } from "../src/cli/stop.js";
import { describeDbFailure } from "../src/db-problem.js";
import { BUSY_MESSAGE } from "../src/restore.js";
import { slow } from "./setup-env.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const roots: string[] = [];
const kids: ChildProcess[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function scratchEnv(port: number): { home: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "mm-stop-"));
  roots.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, MONOMEM_HOME: join(home, "data"), MONOMEM_PORT: String(port), NO_COLOR: "1" };
  return { home, env };
}

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A stand-in for the background server: answers GET /health with 200 and prints its port. */
async function fakeServer(): Promise<{ child: ChildProcess; port: number }> {
  const code = `require("http").createServer((q,s)=>{s.writeHead(q.url==="/health"?200:404);s.end("{}")}).listen(0,"127.0.0.1",function(){console.log(this.address().port)})`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "ignore"] });
  kids.push(child);
  const port = await new Promise<number>((res, rej) => {
    child.stdout!.once("data", (d) => res(Number(String(d).trim())));
    child.once("exit", () => rej(new Error("fake server died")));
  });
  return { child, port };
}

const runCli = (env: NodeJS.ProcessEnv, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: slow(30_000) });

describe("monomem stop", () => {
  test("stops the server monomem open recorded for this store and forgets it", async () => {
    const { child, port } = await fakeServer();
    const { env, home } = scratchEnv(port);
    const file = pidFile(join(home, "data", "state.db"));
    writeFileSync(file, JSON.stringify({ pid: child.pid, port }));
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const r = runCli(env, "stop");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Stopped Monomem/);
    await exited; // the stand-in really ended (the test times out if not)
    assert.equal(existsSync(file), false);
  });

  test("nothing running and nothing recorded: says so, exit 0", async () => {
    const { env } = scratchEnv(await freePort());
    const r = runCli(env, "stop");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No Monomem server is running/);
  });

  test("a stale record (that server is gone) is removed, nothing is killed", async () => {
    const port = await freePort();
    const { env, home } = scratchEnv(port);
    const file = pidFile(join(home, "data", "state.db"));
    writeFileSync(file, JSON.stringify({ pid: 2147483646, port }));
    const r = runCli(env, "stop");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no longer running/);
    assert.equal(existsSync(file), false);
  });

  test("a server it did not start is left alone, and the person is told how to stop it", async () => {
    const { child, port } = await fakeServer();
    const { env } = scratchEnv(port);
    const r = runCli(env, "stop");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Ctrl\+C/);
    assert.match(r.stdout, /service uninstall/);
    assert.equal(child.exitCode, null);
  });

  test("the messages that say to stop the server name the command", () => {
    assert.match(BUSY_MESSAGE, /monomem stop/);
    assert.match(describeDbFailure("/x/state.db", new Error("database disk image is malformed")).fix, /monomem stop/);
    assert.match(describeDbFailure("/x/state.db", new Error("database is locked")).fix, /monomem stop/);
  });

  test("stop is in the short help", () => {
    assert.match(runCli({ ...process.env, NO_COLOR: "1" }, "help").stdout, /^ {2}stop {2,}/m);
  });
});
