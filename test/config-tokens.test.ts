// resolveTokens() parses the primary token + optional scoped tokens from the
// environment. These tests drive it purely via env vars (no files), restoring
// the environment after each case.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { resolveToken, resolveTokens, type TokenEntry } from "../src/config.js";

// User-supplied tokens must be >= 32 chars.
const L = (n: string): string => n.padEnd(32, "-");
const SAVE = { tok: process.env.MONOMEM_TOKEN, list: process.env.MONOMEM_TOKENS };

function scopeOf(list: TokenEntry[], token: string): string | undefined {
  return list.find((e) => e.token === token)?.scope;
}

describe("resolveTokens", () => {
  afterEach(() => {
    if (SAVE.tok === undefined) delete process.env.MONOMEM_TOKEN;
    else process.env.MONOMEM_TOKEN = SAVE.tok;
    if (SAVE.list === undefined) delete process.env.MONOMEM_TOKENS;
    else process.env.MONOMEM_TOKENS = SAVE.list;
  });

  test("primary token is admin; valid scoped tokens are added, invalid ones skipped", () => {
    process.env.MONOMEM_TOKEN = L("PRIMARY");
    process.env.MONOMEM_TOKENS = JSON.stringify([
      { token: L("R"), scope: "read" },
      { token: L("W"), scope: "write", label: "writer" },
      { token: L("BAD"), scope: "superuser" }, // invalid scope -> skipped
      { token: "", scope: "read" }, // empty token -> skipped
    ]);
    const t = resolveTokens();
    assert.equal(scopeOf(t, L("PRIMARY")), "admin");
    assert.equal(scopeOf(t, L("R")), "read");
    assert.equal(scopeOf(t, L("W")), "write");
    assert.equal(scopeOf(t, L("BAD")), undefined);
    assert.equal(t.some((e) => e.token === ""), false);
  });

  test("malformed MONOMEM_TOKENS does not throw and keeps the primary", () => {
    process.env.MONOMEM_TOKEN = L("PRIMARY");
    process.env.MONOMEM_TOKENS = "{not valid json";
    const t = resolveTokens();
    assert.equal(scopeOf(t, L("PRIMARY")), "admin");
  });

  test("a non-array JSON value is ignored (not applied)", () => {
    process.env.MONOMEM_TOKEN = L("PRIMARY");
    process.env.MONOMEM_TOKENS = JSON.stringify({ token: L("X"), scope: "admin" });
    const t = resolveTokens();
    assert.equal(scopeOf(t, L("X")), undefined);
    assert.equal(scopeOf(t, L("PRIMARY")), "admin");
  });

  test("a duplicate token keeps the MOST restrictive scope", () => {
    process.env.MONOMEM_TOKEN = L("PRIMARY");
    process.env.MONOMEM_TOKENS = JSON.stringify([
      { token: L("D"), scope: "admin" },
      { token: L("D"), scope: "read" },
    ]);
    assert.equal(scopeOf(resolveTokens(), L("D")), "read");
  });

  test("the primary admin token cannot be downgraded by a scoped entry", () => {
    process.env.MONOMEM_TOKEN = L("PRIMARY");
    process.env.MONOMEM_TOKENS = JSON.stringify([{ token: L("PRIMARY"), scope: "read" }]);
    assert.equal(scopeOf(resolveTokens(), L("PRIMARY")), "admin");
  });

  test("short user-supplied tokens in the list are rejected with a stderr message; long ones kept", () => {
    process.env.MONOMEM_TOKEN = L("PRIMARY");
    process.env.MONOMEM_TOKENS = JSON.stringify([
      { token: "short", scope: "read", label: "weak" },
      { token: L("long-enough"), scope: "read" },
    ]);
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    let t: TokenEntry[];
    try {
      t = resolveTokens();
    } finally {
      console.error = orig;
    }
    assert.equal(scopeOf(t, "short"), undefined);
    assert.equal(scopeOf(t, L("long-enough")), "read");
    assert.ok(errs.some((e) => /"weak"/.test(e) && /at least 32/.test(e)), errs.join("|"));
  });

  test("a too-short MONOMEM_TOKEN is refused with a clear error", () => {
    process.env.MONOMEM_TOKEN = "hunter22";
    delete process.env.MONOMEM_TOKENS;
    assert.throws(() => resolveTokens(), /MONOMEM_TOKEN is too short/);
  });
});

describe("the .env.example placeholder key", () => {
  test("is refused with a clear message instead of being accepted as the key", () => {
    const keep = process.env.MONOMEM_TOKEN;
    try {
      process.env.MONOMEM_TOKEN = "change-me-to-a-long-random-string";
      assert.throws(() => resolveToken(), /still the placeholder from \.env\.example/);
      assert.throws(() => resolveTokens(), /still the placeholder/);
    } finally {
      if (keep === undefined) delete process.env.MONOMEM_TOKEN;
      else process.env.MONOMEM_TOKEN = keep;
    }
  });
});
