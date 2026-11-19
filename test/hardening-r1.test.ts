// Expert round 1 hardening (2026-11-18): own-origin check, key-file ACL on Windows (mocked runner), identifier search.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { originAllowed } from "../src/security.js";
import { createApiServer } from "../src/api.js";
import { createMcpHttpServer } from "../src/mcp-http.js";
import { Store } from "../src/store.js";
import { fileLockdownArgs, restrictFile } from "../src/private-dir.js";

const fakeReq = (origin: string | undefined, localPort: number | undefined): any => ({
  headers: origin === undefined ? {} : { origin },
  socket: { localPort },
});

describe("origin check allows this server's own origin only", () => {
  const SAVE = process.env.MONOMEM_ALLOWED_ORIGINS;
  afterEach(() => {
    if (SAVE === undefined) delete process.env.MONOMEM_ALLOWED_ORIGINS;
    else process.env.MONOMEM_ALLOWED_ORIGINS = SAVE;
  });

  test("no Origin (CLI, curl, MCP clients) is allowed", () => assert.equal(originAllowed(fakeReq(undefined, 8790)), true));
  test("loopback origin on the port the request arrived on is allowed", () => {
    for (const o of ["http://127.0.0.1:8790", "http://localhost:8790", "http://[::1]:8790"] ) assert.equal(originAllowed(fakeReq(o, 8790)), true, o);
  });
  test("any other loopback origin is refused", () => {
    for (const o of ["http://localhost:3000", "http://127.0.0.1:8791", "http://localhost", "https://localhost:8790", "http://localhost:80"]) assert.equal(originAllowed(fakeReq(o, 8790)), false, o);
  });
  test("a non-loopback origin is refused, even when it names the same port", () => {
    for (const o of ["http://evil.example:8790", "http://127.0.0.1.evil.example:8790", "null", "not a url"]) assert.equal(originAllowed(fakeReq(o, 8790)), false, o);
  });
  test("the explicit allowlist still works", () => {
    process.env.MONOMEM_ALLOWED_ORIGINS = "https://mm.example.org, http://localhost:3000";
    assert.equal(originAllowed(fakeReq("https://mm.example.org", 8790)), true);
    assert.equal(originAllowed(fakeReq("http://localhost:3000", 8790)), true);
    assert.equal(originAllowed(fakeReq("http://localhost:3001", 8790)), false);
  });
  test("a socket with no local port gets no loopback shortcut", () => assert.equal(originAllowed(fakeReq("http://localhost:8790", undefined)), false));

  test("over real HTTP on both servers: own origin passes, another local port is a 403, no Origin passes", async () => {
    const store = new Store(":memory:");
    for (const server of [createApiServer(store, "tok-admin-1234567890"), createMcpHttpServer(store, "tok-admin-1234567890")]) {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        const port = (server.address() as AddressInfo).port;
        const call = (origin?: string) => fetch(`http://127.0.0.1:${port}/ready`, { headers: origin ? { Origin: origin } : {} });
        assert.notEqual((await call(`http://127.0.0.1:${port}`)).status, 403);
        assert.notEqual((await call(`http://localhost:${port}`)).status, 403);
        assert.notEqual((await call()).status, 403);
        const other = await call("http://localhost:3000");
        assert.equal(other.status, 403);
        assert.deepEqual(await other.json(), { error: "origin not allowed" });
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }
    store.close();
  });
});

describe("key files get a Windows ACL (best effort)", () => {
  const env = { USERNAME: "danie", USERDOMAIN: "DANITA" } as NodeJS.ProcessEnv;

  test("the icacls arguments: inheritance removed, only the current user granted", () => {
    assert.deepEqual(fileLockdownArgs("C:\\d\\.token", env), ["C:\\d\\.token", "/inheritance:r", "/grant:r", "DANITA\\danie:F"]);
    assert.deepEqual(fileLockdownArgs("f", { USERNAME: "bob" } as NodeJS.ProcessEnv), ["f", "/inheritance:r", "/grant:r", "bob:F"]);
    assert.equal(fileLockdownArgs("f", {} as NodeJS.ProcessEnv), null);
  });
  test("on win32 the runner is called with those arguments", () => {
    const calls: string[][] = [];
    restrictFile("C:\\d\\.token", { platform: "win32", env, run: (a) => void calls.push(a) });
    assert.deepEqual(calls, [["C:\\d\\.token", "/inheritance:r", "/grant:r", "DANITA\\danie:F"]]);
  });
  test("off Windows nothing runs", () => {
    const calls: string[][] = [];
    restrictFile("/d/.token", { platform: "linux", env, run: (a) => void calls.push(a) });
    assert.equal(calls.length, 0);
  });
  test("a failing runner never throws, and warns once", () => {
    const seen: string[] = [];
    const orig = console.error;
    console.error = (m: unknown) => void seen.push(String(m));
    try {
      const boom = (): void => {
        throw new Error("icacls is not installed");
      };
      assert.doesNotThrow(() => restrictFile("C:\\a", { platform: "win32", env, run: boom }));
      assert.doesNotThrow(() => restrictFile("C:\\b", { platform: "win32", env, run: boom }));
      assert.doesNotThrow(() => restrictFile("C:\\c", { platform: "win32", env: {} as NodeJS.ProcessEnv, run: boom }));
    } finally {
      console.error = orig;
    }
    assert.ok(seen.length <= 1, `at most one warning per process, got ${seen.length}`);
    if (seen.length) assert.match(seen[0], /could not restrict .* icacls/);
  });
});
