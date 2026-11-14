// 1.5.0 R1-11: on Windows a newly created data folder is locked to its owner and SYSTEM (icacls, no shell, best effort),
// and `monomem doctor` can say when an existing one is open to other accounts. Protects from other accounts on the PC, not
// from programs running as you.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDir, lockdownArgs, wideAccessGroups } from "../src/config.js";

const ENV = { USERDOMAIN: "DESK", USERNAME: "dan" } as NodeJS.ProcessEnv;

describe("R1-11 data folder ACL", () => {
  test("lockdownArgs: the owner and SYSTEM only, inheritance removed", () => {
    assert.deepEqual(lockdownArgs("C:\\d", ENV), ["C:\\d", "/inheritance:r", "/grant:r", "DESK\\dan:(OI)(CI)F", "SYSTEM:(OI)(CI)F"]);
    assert.equal(lockdownArgs("C:\\d", {} as NodeJS.ProcessEnv), null, "no user name: no guessing");
  });

  test("a NEW folder is locked down once (win32); an existing one, and other platforms, are not touched", () => {
    const base = mkdtempSync(join(tmpdir(), "mm-acl-"));
    try {
      const calls: string[][] = [];
      const run = (a: string[]): void => void calls.push(a);
      privateDir(join(base, "fresh"), { platform: "win32", env: ENV, run });
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], join(base, "fresh"));
      privateDir(join(base, "fresh"), { platform: "win32", env: ENV, run });
      assert.equal(calls.length, 1, "already there: no icacls call");
      privateDir(join(base, "linux"), { platform: "linux", env: ENV, run });
      assert.equal(calls.length, 1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a failing icacls is one warning on stderr, never fatal", () => {
    const base = mkdtempSync(join(tmpdir(), "mm-acl-"));
    const err = console.error;
    const lines: string[] = [];
    console.error = (m: string) => void lines.push(String(m));
    try {
      privateDir(join(base, "x"), {
        platform: "win32",
        env: ENV,
        run: () => {
          throw new Error("denied");
        },
      });
      assert.ok(existsSync(join(base, "x")));
      assert.equal(lines.length, 1);
      assert.match(lines[0], /icacls/);
    } finally {
      console.error = err;
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("wideAccessGroups reads icacls output", () => {
    const out = [
      "C:\\Users\\dan\\.monomem BUILTIN\\Administrators:(OI)(CI)(F)",
      "                         NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
      "                         BUILTIN\\Users:(OI)(CI)(RX)",
      "                         DESK\\dan:(OI)(CI)(F)",
      "                         NT AUTHORITY\\Authenticated Users:(I)(M)",
      "                         Everyone:(R)",
    ].join("\n");
    assert.deepEqual(wideAccessGroups(out), ["BUILTIN\\Administrators", "BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users", "Everyone"]);
    assert.deepEqual(wideAccessGroups("C:\\x DESK\\dan:(OI)(CI)(F)\n NT AUTHORITY\\SYSTEM:(F)"), []);
  });

  test("win32 only: a freshly created folder really loses BUILTIN\\Users", { skip: process.platform !== "win32" }, () => {
    const base = mkdtempSync(join(tmpdir(), "mm-acl-real-"));
    try {
      const d = join(base, "data");
      privateDir(d);
      const out = execFileSync("icacls", [d], { encoding: "utf8" });
      assert.ok(!/BUILTIN\\Users/i.test(out), out);
      assert.ok(!/Everyone/i.test(out), out);
      assert.ok(out.toLowerCase().includes((process.env.USERNAME ?? "?").toLowerCase()), out);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
