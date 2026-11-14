// 1.5.0 R1-10 (owner decision 2026-11-14): app keys in tokens.json are stored as sha256 hashes, and keys made by an older
// version are hashed automatically on first start (atomic, no plaintext .bak, idempotent, clients unaffected).
// This file owns the process-wide data folder (node --test runs each file in its own process).
import "./setup-env.js";
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { DATA_DIR, resolveTokens } from "../src/config.js";
import { addApp, hardenTokensFile, listApps, removeApp } from "../src/tokens-admin.js";
import { authenticateEntry } from "../src/security.js";
import { lintContent } from "../src/lint.js";

const FILE = join(DATA_DIR, "tokens.json");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const req = (key: string): IncomingMessage => ({ headers: { authorization: `Bearer ${key}` } }) as unknown as IncomingMessage;
const raw = (): any[] => JSON.parse(readFileSync(FILE, "utf8"));
const LEGACY = "L".repeat(40);
const LEGACY2 = "M".repeat(48);
const quiet = (fn: () => void): void => {
  const e = console.error;
  console.error = () => {};
  try {
    fn();
  } finally {
    console.error = e;
  }
};

beforeEach(() => {
  rmSync(FILE, { force: true });
  rmSync(FILE + ".bak", { force: true });
});

describe("R1-10 new keys are stored hashed", () => {
  test("token add writes token_sha256 and no plaintext; the key still authenticates and lists", () => {
    const made = addApp({ label: "cursor" });
    const row = raw()[0];
    assert.equal(row.token, undefined, "no plaintext key in tokens.json");
    assert.equal(row.token_sha256, sha(made.token));
    assert.ok(!readFileSync(FILE, "utf8").includes(made.token), "the key text is nowhere in the file");
    const entry = authenticateEntry(req(made.token), resolveTokens());
    assert.equal(entry?.label, "cursor");
    assert.equal(authenticateEntry(req(made.token + "x"), resolveTokens()), null);
    assert.equal(listApps().find((a) => a.label === "cursor")?.source, "file");
    assert.equal(removeApp("cursor"), true);
    assert.equal(authenticateEntry(req(made.token), resolveTokens()), null);
  });

  test("a legacy plaintext entry still authenticates, and a mixed file works", () => {
    writeFileSync(FILE, JSON.stringify([{ token: LEGACY, scope: "read", label: "old-app" }]));
    const made = addApp({ label: "new-app" });
    const toks = resolveTokens();
    assert.equal(authenticateEntry(req(LEGACY), toks)?.label, "old-app");
    assert.equal(authenticateEntry(req(made.token), toks)?.label, "new-app");
  });

  test("a hashed entry in MONOMEM_TOKENS works, and the same key listed in plaintext and hashed is one entry (most restrictive scope)", () => {
    process.env.MONOMEM_TOKENS = JSON.stringify([{ token_sha256: sha(LEGACY), scope: "read", label: "h" }, { token: LEGACY, scope: "admin", label: "p" }]);
    try {
      const toks = resolveTokens().filter((t) => t.label !== "primary");
      assert.equal(toks.length, 1);
      assert.equal(toks[0].scope, "read");
      assert.equal(authenticateEntry(req(LEGACY), toks)?.scope, "read");
    } finally {
      delete process.env.MONOMEM_TOKENS;
    }
  });

  test("an entry with both a key and a hash, or a malformed hash, is refused", () => {
    writeFileSync(FILE, JSON.stringify([{ token: LEGACY, token_sha256: sha(LEGACY), scope: "read", label: "both" }, { token_sha256: "abc", scope: "read", label: "bad" }]));
    quiet(() => assert.equal(resolveTokens().filter((t) => t.label !== "primary").length, 0));
  });

  test("a note that contains a hashed key's value is refused by the linter", () => {
    const made = addApp({ label: "leaky" });
    const findings = lintContent({ title: "setup", body: `use header Authorization: Bearer ${made.token} for the api` });
    assert.ok(findings.some((f) => f.category === "secret" && /token/i.test(f.label)), JSON.stringify(findings));
    // legacy plaintext shape still caught
    writeFileSync(FILE, JSON.stringify([{ token: LEGACY2, scope: "read", label: "old" }]));
    assert.ok(lintContent({ title: "x", body: `key ${LEGACY2}` }).some((f) => f.category === "secret"));
    // a hashed user-chosen (non-hex) key is found too
    writeFileSync(FILE, JSON.stringify([{ token_sha256: sha(LEGACY2), scope: "read", label: "old" }]));
    assert.ok(lintContent({ title: "x", body: `key ${LEGACY2}` }).some((f) => f.category === "secret"));
    assert.deepEqual(lintContent({ title: "x", body: "nothing here but " + "a1".repeat(32) }).filter((f) => f.category === "secret"), []);
  });
});

describe("R1-10 (owner decision) keys from an older version are hashed on first start", () => {
  const seed = (): void => {
    writeFileSync(FILE, JSON.stringify([{ token: LEGACY, scope: "write", label: "a", namespace: "work", max_sensitivity: "internal", created_at: "2026-01-01T00:00:00Z" }, { token: LEGACY2, scope: "read", label: "b" }, { token: "short", scope: "read", label: "weak" }]));
    writeFileSync(FILE + ".bak", readFileSync(FILE));
  };

  test("plaintext keys become hashes, other fields survive, the .bak is gone, clients are unaffected", () => {
    seed();
    const r = hardenTokensFile();
    assert.equal(r.converted, 2);
    const rows = raw();
    assert.deepEqual([rows[0].token, rows[1].token], [undefined, undefined]);
    assert.equal(rows[0].token_sha256, sha(LEGACY));
    assert.equal(rows[0].namespace, "work");
    assert.equal(rows[0].max_sensitivity, "internal");
    assert.equal(rows[0].created_at, "2026-01-01T00:00:00Z");
    assert.equal(rows[2].token, "short", "a key too short to be accepted is left alone, not made acceptable");
    assert.ok(!existsSync(FILE + ".bak"), "no plaintext .bak is left behind");
    const toks = resolveTokens();
    assert.equal(authenticateEntry(req(LEGACY), toks)?.label, "a");
    assert.equal(authenticateEntry(req(LEGACY2), toks)?.scope, "read");
    assert.equal(authenticateEntry(req("short"), toks), null);
  });

  test("idempotent: a second run changes nothing", () => {
    seed();
    hardenTokensFile();
    const before = readFileSync(FILE, "utf8");
    const mtime = statSync(FILE).mtimeMs;
    const r = hardenTokensFile();
    assert.equal(r.converted, 0);
    assert.equal(readFileSync(FILE, "utf8"), before);
    assert.equal(statSync(FILE).mtimeMs, mtime, "not even rewritten");
  });

  test("atomic: no temp file left, and a broken tokens.json is left untouched", () => {
    seed();
    hardenTokensFile();
    assert.deepEqual(readdirSync(DATA_DIR).filter((f) => f.startsWith("tokens.json.") && f !== "tokens.json.lock"), []);
    writeFileSync(FILE, "{ not json");
    assert.equal(hardenTokensFile().converted, 0);
    assert.equal(readFileSync(FILE, "utf8"), "{ not json");
  });

  test("no file at all is fine; a stale .bak with no plaintext left is still removed", () => {
    assert.equal(hardenTokensFile().converted, 0);
    writeFileSync(FILE, "[]");
    writeFileSync(FILE + ".bak", JSON.stringify([{ token: LEGACY, scope: "read", label: "gone" }]));
    hardenTokensFile();
    assert.ok(!existsSync(FILE + ".bak"));
  });
});
