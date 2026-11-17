// OAuth front door for claude.ai / ChatGPT remote connectors (PLAN D/I). Off by default; when on, a grant becomes an
// ordinary tokens.json key (label "oauth:<client>"), so every existing gate applies. These are the security checks the
// lane brief names: PKCE S256 required, redirect_uri exact match, single-use 60 s codes, no open redirect, CSRF on the
// consent form, rate limits on /token and /authorize, refresh rotation with reuse detection, and no secret in any log.
// This file owns the process-wide data folder (node --test runs each file in its own process).
import "./setup-env.js";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createMcpHttpServer } from "../src/mcp-http.js";
import { DATA_DIR, OAUTH_KEY_MARKER, resolveTokens, type TokenEntry } from "../src/config.js";
import { confirmWriter, onProbation } from "../src/store/probation.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { listApps, removeApp } from "../src/tokens-admin.js";
import { clock, newPairCode, readState, setEnabled, usePairCode, allowRedirectOrigin, PAIR_MAX_FAILS } from "../src/oauth/state.js";
import { resetOAuthMemory, grantsForList } from "../src/oauth/routes.js";
import { createApiServer } from "../src/api.js";
import { auditPath, authenticateEntry } from "../src/security.js";
import type { IncomingMessage } from "node:http";

/** The `op` of every audit line so far. */
const auditOps = (): string[] =>
  existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { op: string }).op) : [];

const ADMIN = "a".repeat(64);
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const b64url = (b: Buffer): string => b.toString("base64url");
const pkce = (): { verifier: string; challenge: string } => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();

describe("OAuth front door", () => {
  let store: Store;
  let server: ReturnType<typeof createMcpHttpServer>;
  let base: string;
  let tokens: TokenEntry[];
  let api: ReturnType<typeof createApiServer>;
  let apiBase: string;

  before(async () => {
    store = new Store(":memory:");
    tokens = [{ token: ADMIN, scope: "admin", label: "primary" }];
    server = createMcpHttpServer(store, tokens);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    api = createApiServer(store, tokens);
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => api.close(() => r()));
    store.close();
  });
  beforeEach(() => {
    rmSync(join(DATA_DIR, "tokens.json"), { force: true });
    rmSync(join(DATA_DIR, "oauth.json"), { force: true });
    tokens.splice(1);
    resetOAuthMemory();
    clock.now = () => Date.now();
  });

  const on = (): void => {
    setEnabled(true, base);
  };
  const register = async (redirect_uris: string[] = [CLAUDE_CB], name = "Claude"): Promise<string> => {
    const r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris }) });
    assert.equal(r.status, 201);
    return ((await r.json()) as { client_id: string }).client_id;
  };
  const authorizeUrl = (client_id: string, challenge: string, extra: Record<string, string> = {}): string =>
    `${base}/authorize?` + form({ response_type: "code", client_id, redirect_uri: CLAUDE_CB, code_challenge: challenge, code_challenge_method: "S256", state: "st1", resource: `${base}/mcp`, ...extra });
  /** GET the consent page; returns the request id and the CSRF cookie + field. */
  const consentPage = async (url: string): Promise<{ rid: string; csrf: string; cookie: string; html: string }> => {
    const r = await fetch(url, { redirect: "manual" });
    assert.equal(r.status, 200, await r.clone().text());
    const html = await r.text();
    const rid = /name="request_id" value="([^"]+)"/.exec(html)![1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    return { rid, csrf, cookie, html };
  };
  const consent = (p: { rid: string; csrf: string; cookie: string }, fields: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: p.cookie, ...headers }, body: form({ request_id: p.rid, csrf: p.csrf, action: "allow", ...fields }) });
  const token = (o: Record<string, string>): Promise<Response> =>
    fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form(o) });
  /** A full person-approved flow; returns the code and the verifier. */
  const getCode = async (scope = "read"): Promise<{ client_id: string; code: string; verifier: string }> => {
    const client_id = await register();
    const { verifier, challenge } = pkce();
    const page = await consentPage(authorizeUrl(client_id, challenge));
    const r = await consent(page, { pair_code: newPairCode(), scope });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get("location")!);
    assert.equal(loc.origin + loc.pathname, CLAUDE_CB);
    assert.equal(loc.searchParams.get("state"), "st1");
    assert.equal(loc.searchParams.get("iss"), base);
    return { client_id, code: loc.searchParams.get("code")!, verifier };
  };
  const exchange = async (scope = "read"): Promise<{ client_id: string; access: string; refresh: string; body: Record<string, unknown> }> => {
    const c = await getCode(scope);
    const r = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client_id, redirect_uri: CLAUDE_CB, resource: `${base}/mcp` });
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(r.status, 200, JSON.stringify(body));
    return { client_id: c.client_id, access: body.access_token as string, refresh: body.refresh_token as string, body };
  };
  const mcpList = (key: string): Promise<Response> =>
    fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

  test("off by default: every OAuth route is 404 and the 401 has no resource_metadata", async () => {
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/authorize"]) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
    for (const p of ["/register", "/token", "/revoke", "/authorize"]) assert.equal((await fetch(base + p, { method: "POST" })).status, 404, p);
    const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get("www-authenticate"), null);
  });

  test("on: metadata follows RFC 9728 / RFC 8414 and the 401 points at it", async () => {
    on();
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    assert.equal(prm.resource, `${base}/mcp`);
    assert.deepEqual(prm.authorization_servers, [base]);
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.issuer, base);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.equal(as.registration_endpoint, `${base}/register`);
    assert.ok(!(as.scopes_supported as string[]).includes("admin"));
    const r = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  });

  test("register refuses plain-http non-loopback and fragment redirect URIs", async () => {
    on();
    for (const bad of [["http://evil.example/cb"], ["https://a.example/cb#x"], [], ["javascript:alert(1)"]]) {
      const r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: bad }) });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });

  test("full flow: the grant is an ordinary app key with the chosen scope, a ceiling and reads_outside", async () => {
    on();
    const t = await exchange("write");
    assert.equal(t.body.token_type, "Bearer");
    assert.equal(t.body.scope, "write");
    assert.ok((t.body.expires_in as number) <= 3600);
    assert.equal((await mcpList(t.access)).status, 200);
    const app = listApps().find((a) => a.label.startsWith("oauth:Claude"));
    assert.ok(app, "listed in monomem keys");
    assert.equal(app!.scope, "write");
    assert.equal(app!.source, "file");
    assert.equal(app!.max_sensitivity, "internal");
    const entry = resolveTokens().find((e) => e.label === app!.label)!;
    assert.equal(entry.reads_outside, true);
    assert.equal(entry.token, undefined, "hashed at rest");
  });

  test("PKCE is required: no challenge, a plain challenge, or a wrong verifier all fail", async () => {
    on();
    const client_id = await register();
    const cases: Record<string, string>[] = [{ code_challenge: "" }, { code_challenge_method: "plain" }];
    for (const extra of cases) {
      const r = await fetch(authorizeUrl(client_id, pkce().challenge, extra), { redirect: "manual" });
      assert.equal(r.status, 302);
      const loc = new URL(r.headers.get("location")!);
      assert.equal(loc.searchParams.get("error"), "invalid_request");
      assert.equal(loc.searchParams.get("iss"), base);
    }
    const c = await getCode();
    const r = await token({ grant_type: "authorization_code", code: c.code, code_verifier: pkce().verifier, client_id: c.client_id, redirect_uri: CLAUDE_CB });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "invalid_grant");
  });

  test("a code is single-use and expires after 60 s", async () => {
    on();
    const c = await getCode();
    const ok = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client_id, redirect_uri: CLAUDE_CB });
    assert.equal(ok.status, 200);
    const again = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client_id, redirect_uri: CLAUDE_CB });
    assert.equal(again.status, 400);
    const late = await getCode();
    const t0 = Date.now();
    clock.now = () => t0 + 61_000;
    const r = await token({ grant_type: "authorization_code", code: late.code, code_verifier: late.verifier, client_id: late.client_id, redirect_uri: CLAUDE_CB });
    assert.equal(r.status, 400);
  });

  test("redirect_uri must match exactly; an unknown client or a foreign redirect never redirects (no open redirect)", async () => {
    on();
    const client_id = await register();
    for (const u of [authorizeUrl(client_id, pkce().challenge, { redirect_uri: "https://evil.example/cb" }), authorizeUrl(client_id, pkce().challenge, { redirect_uri: CLAUDE_CB + "/x" }), authorizeUrl("nope", pkce().challenge)]) {
      const r = await fetch(u, { redirect: "manual" });
      assert.equal(r.status, 400, u);
      assert.equal(r.headers.get("location"), null);
    }
    const c = await getCode();
    const r = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client_id, redirect_uri: "https://claude.ai/other" });
    assert.equal(r.status, 400);
  });

  test("loopback redirects match with any port (RFC 8252), other hosts do not", async () => {
    on();
    const client_id = await register(["http://localhost/callback"], "Claude Code");
    const ok = await fetch(authorizeUrl(client_id, pkce().challenge, { redirect_uri: "http://localhost:3118/callback" }), { redirect: "manual" });
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /only to a program on this computer/);
    const bad = await fetch(authorizeUrl(client_id, pkce().challenge, { redirect_uri: "http://localhost:3118/other" }), { redirect: "manual" });
    assert.equal(bad.status, 400);
  });

  test("no pairing code, no grant; five wrong codes end that consent request but do not burn the owner's code (S3)", async () => {
    on();
    const client_id = await register();
    const page = await consentPage(authorizeUrl(client_id, pkce().challenge));
    assert.equal((await consent(page, { scope: "read" })).status, 400);
    const code = newPairCode();
    for (let i = 0; i < 5; i++) assert.equal((await consent(page, { pair_code: "WRONG-CODE", scope: "read" })).status, 400);
    assert.equal((await consent(page, { pair_code: code, scope: "read" })).status, 400, "that consent request is over");
    const page2 = await consentPage(authorizeUrl(client_id, pkce().challenge));
    const r = await consent(page2, { pair_code: code, scope: "read" });
    assert.equal(r.status, 302, "an outsider's wrong guesses did not lock the owner out");
  });

  test("the pairing code burns only after PAIR_MAX_FAILS wrong codes in total, and the burn is audited (S3, L6)", () => {
    on();
    newPairCode();
    for (let i = 0; i < PAIR_MAX_FAILS - 1; i++) assert.equal(usePairCode("WRONG"), false);
    assert.ok(readState().pair, "still alive one short of the limit");
    assert.equal(usePairCode("WRONG"), false);
    assert.equal(readState().pair, undefined, "burned");
    assert.ok(PAIR_MAX_FAILS >= 500, "high enough that one caller cannot reach it within the 10-minute life under the rate limit");
    assert.ok(auditOps().includes("oauth.pair.burn"));
  });

  test("CSRF: the consent POST needs the matching cookie and refuses a cross-site Origin", async () => {
    on();
    const client_id = await register();
    const page = await consentPage(authorizeUrl(client_id, pkce().challenge));
    const code = newPairCode();
    assert.equal((await consent({ ...page, cookie: "" }, { pair_code: code, scope: "read" })).status, 403);
    assert.equal((await consent({ ...page, cookie: "mm_oauth_csrf=" + "x".repeat(43) }, { pair_code: code, scope: "read" })).status, 403);
    assert.equal((await consent(page, { pair_code: code, scope: "read" }, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await consent(page, { pair_code: code, scope: "read" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await consent(page, { pair_code: code, scope: "read" }, { Origin: base })).status, 302);
  });

  test("never admin: an admin scope on the consent form is refused", async () => {
    on();
    const client_id = await register();
    const page = await consentPage(authorizeUrl(client_id, pkce().challenge));
    assert.equal((await consent(page, { pair_code: newPairCode(), scope: "admin" })).status, 400);
  });

  test("the consent page escapes the client name and shows the redirect host", async () => {
    on();
    const client_id = await register([CLAUDE_CB], "<script>alert(1)</script>");
    const { html } = await consentPage(authorizeUrl(client_id, pkce().challenge));
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.match(html, /claude\.ai/);
  });

  test("refresh rotates; reusing an old refresh token revokes the whole grant", async () => {
    on();
    const t = await exchange();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.client_id });
    const b1 = (await r1.json()) as { access_token: string; refresh_token: string };
    assert.equal(r1.status, 200);
    assert.notEqual(b1.refresh_token, t.refresh);
    assert.equal((await mcpList(b1.access_token)).status, 200);
    assert.equal((await mcpList(t.access)).status, 401, "the old access token stops working");
    const t0 = Date.now();
    clock.now = () => t0 + 11_000; // past the retry grace window
    const reuse = await token({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.client_id });
    assert.equal(reuse.status, 400);
    assert.equal(((await reuse.json()) as { error: string }).error, "invalid_grant");
    assert.equal((await mcpList(b1.access_token)).status, 401, "the grant is gone");
    assert.equal(listApps().some((a) => a.label.startsWith("oauth:")), false);
  });

  test("removing the key (monomem keys remove / dashboard) ends the grant: refresh fails", async () => {
    on();
    const t = await exchange();
    const label = listApps().find((a) => a.label.startsWith("oauth:"))!.label;
    assert.equal(removeApp(label), true);
    const r = await token({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.client_id });
    assert.equal(r.status, 400);
    assert.equal(readState().grants.length, 0);
  });

  test("an access token expires after an hour", async () => {
    on();
    const t = await exchange();
    const t0 = Date.now();
    const realNow = Date.now;
    Date.now = () => t0 + 3601_000;
    try {
      assert.equal((await mcpList(t.access)).status, 401);
    } finally {
      Date.now = realNow;
    }
  });

  test("revoke ends the grant", async () => {
    on();
    const t = await exchange();
    const r = await fetch(`${base}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ token: t.refresh, client_id: t.client_id }) });
    assert.equal(r.status, 200);
    assert.equal((await mcpList(t.access)).status, 401);
  });

  test("turning OAuth off makes every route 404 again", async () => {
    on();
    setEnabled(false);
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
  });

  test("rate limits: /token and /authorize answer 429 under a flood", async () => {
    on();
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await token({ grant_type: "refresh_token", refresh_token: "x", client_id: "y" })).status);
    assert.ok(codes.includes(429), "token");
    const a: number[] = [];
    for (let i = 0; i < 70; i++) a.push((await fetch(`${base}/authorize?client_id=x`, { redirect: "manual" })).status);
    assert.ok(a.includes(429), "authorize");
  });

  test("no secret reaches a log: codes, keys and pairing codes never printed", async () => {
    on();
    const out: string[] = [];
    const saved = { log: console.log, error: console.error, warn: console.warn, w: process.stderr.write.bind(process.stderr), o: process.stdout.write.bind(process.stdout) };
    console.log = console.error = console.warn = (...a: unknown[]) => void out.push(a.join(" "));
    process.stderr.write = ((s: string) => (out.push(String(s)), true)) as typeof process.stderr.write;
    let secrets: string[] = [];
    try {
      const c = await getCode();
      const pair = readState().pair;
      const r = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client_id, redirect_uri: CLAUDE_CB });
      const b = (await r.json()) as { access_token: string; refresh_token: string };
      await token({ grant_type: "refresh_token", refresh_token: b.refresh_token, client_id: c.client_id });
      await token({ grant_type: "refresh_token", refresh_token: b.refresh_token, client_id: c.client_id }); // reuse path logs too
      secrets = [c.code, c.verifier, b.access_token, b.refresh_token, ...(pair ? [pair.sha256] : [])];
    } finally {
      Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn });
      process.stderr.write = saved.w;
    }
    const all = out.join("\n");
    for (const s of secrets) assert.ok(!all.includes(s), "a secret was printed");
    const { readFileSync, existsSync } = await import("node:fs");
    const { auditPath } = await import("../src/security.js");
    if (existsSync(auditPath())) {
      const log = readFileSync(auditPath(), "utf8");
      for (const s of secrets) assert.ok(!log.includes(s), "a secret is in the audit log");
    }
  });

  // ---- r3 OAuth security review (.panel-160/r3-oauth-security.md) ----

  test("S1: an unknown https redirect host is refused at registration unless allowed at a terminal; then the page warns", async () => {
    on();
    const bad = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://attacker.example/cb"] }) });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_redirect_uri");
    allowRedirectOrigin("https://attacker.example");
    const r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://attacker.example/cb"] }) });
    assert.equal(r.status, 201);
    const cid = ((await r.json()) as { client_id: string }).client_id;
    const { html } = await consentPage(authorizeUrl(cid, pkce().challenge, { redirect_uri: "https://attacker.example/cb" }));
    assert.match(html, /NOT claude\.ai or chatgpt\.com/);
    assert.match(html, /https:\/\/attacker\.example/, "the full origin is shown");
    const known = await consentPage(authorizeUrl(await register(), pkce().challenge));
    assert.doesNotMatch(known.html, /NOT claude\.ai/);
    assert.match(known.html, /https:\/\/claude\.ai/);
    assert.ok(auditOps().includes("oauth.allow-redirect"));
  });

  test("S1: a client registered for a host that is no longer allowed cannot start a sign-in", async () => {
    on();
    allowRedirectOrigin("https://attacker.example");
    const cid = await register(["https://attacker.example/cb"]);
    allowRedirectOrigin("https://attacker.example", true);
    const r = await fetch(authorizeUrl(cid, pkce().challenge, { redirect_uri: "https://attacker.example/cb" }), { redirect: "manual" });
    assert.equal(r.status, 400);
    assert.equal(r.headers.get("location"), null);
  });

  test("S2: oauth off revokes every grant and its key; on again does not bring them back (L6 audited)", async () => {
    on();
    const t = await exchange();
    setEnabled(false);
    assert.equal(readState().grants.length, 0);
    assert.equal(resolveTokens().some((e) => e.label.startsWith("oauth:")), false, "the key is gone from tokens.json");
    on();
    const r = await token({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.client_id });
    assert.equal(r.status, 400);
    const ops = auditOps();
    assert.ok(ops.includes("oauth.off") && ops.includes("oauth.on"));
  });

  test("L2: a parallel refresh retry with the same token does not kill the grant", async () => {
    on();
    const t = await exchange();
    const [a, b] = await Promise.all([1, 2].map(() => token({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.client_id })));
    assert.deepEqual([a.status, b.status].sort(), [200, 400]);
    const ok = a.status === 200 ? a : b;
    assert.equal(readState().grants.length, 1, "the grant survives");
    assert.equal((await mcpList(((await ok.json()) as { access_token: string }).access_token)).status, 200);
  });

  test("L3: a refresh keeps a namespace and a stricter ceiling set by hand", async () => {
    on();
    const t = await exchange();
    const f = join(DATA_DIR, "tokens.json");
    const rows = JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>;
    writeFileSync(f, JSON.stringify(rows.map((r) => (String(r.label).startsWith("oauth:") ? { ...r, namespace: "work", max_sensitivity: "public" } : r))));
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.client_id })).status, 200);
    const row = (JSON.parse(readFileSync(f, "utf8")) as Array<Record<string, unknown>>).find((r) => String(r.label).startsWith("oauth:"))!;
    assert.equal(row.namespace, "work");
    assert.equal(row.max_sensitivity, "public");
    const live = tokens.find((e) => e.label === row.label);
    assert.equal(live?.max_sensitivity, "public", "the live key too");
    assert.equal(live?.namespace, "work");
  });

  test("L4: control and bidi characters are stripped from the client name", async () => {
    on();
    const [RLO, ESC, ZWSP] = [0x202e, 0x1b, 0x200b].map((c) => String.fromCharCode(c));
    const cid = await register([CLAUDE_CB], `Cl${RLO}ia.edualc${ESC}[31mRED${ZWSP}`);
    const { html } = await consentPage(authorizeUrl(cid, pkce().challenge));
    for (const ch of [RLO, ESC, ZWSP]) assert.ok(!html.includes(ch));
    assert.ok(readState().clients.every((c) => !/[\p{Cc}\p{Cf}]/u.test(c.client_name)));
    assert.ok(grantsForList().every((g) => !/[\p{Cc}\p{Cf}]/u.test(g.client_name)));
  });

  test("L5: replaying a used code revokes the tokens issued from it (audited)", async () => {
    on();
    const c = await getCode();
    const first = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client_id, redirect_uri: CLAUDE_CB });
    const b = (await first.json()) as { access_token: string };
    const replay = await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client_id, redirect_uri: CLAUDE_CB });
    assert.equal(replay.status, 400);
    assert.equal((await mcpList(b.access_token)).status, 401);
    assert.equal(readState().grants.length, 0);
    assert.ok(auditOps().includes("oauth.code-replay"));
  });

  test("L6: registrations are audited", async () => {
    on();
    await register();
    assert.ok(auditOps().includes("oauth.register"));
  });

  test("L7: dead grants, their keys and unused clients are swept on /register and /token", async () => {
    on();
    await exchange();
    const t0 = Date.now();
    clock.now = () => t0 + 31 * 24 * 3600_000; // the refresh token has expired, the client is weeks old
    await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: [CLAUDE_CB] }) });
    assert.equal(readState().grants.length, 0);
    assert.equal(listApps().some((a) => a.label.startsWith("oauth:")), false);
    assert.equal(readState().clients.length, 1, "only the new client is left");
    clock.now = () => Date.now();
    await exchange();
    removeApp(listApps().find((a) => a.label.startsWith("oauth:"))!.label);
    await token({ grant_type: "refresh_token", refresh_token: "unrelated", client_id: "x" });
    assert.equal(readState().grants.length, 0, "a grant whose key the person removed is swept");
  });

  test("L8: redirect_uri at /token is required only when it was sent to /authorize", async () => {
    on();
    const cid = await register();
    const { verifier, challenge } = pkce();
    const url = `${base}/authorize?` + form({ response_type: "code", client_id: cid, code_challenge: challenge, code_challenge_method: "S256", state: "s" });
    const r = await consent(await consentPage(url), { pair_code: newPairCode(), scope: "read" });
    const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
    assert.equal((await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: cid })).status, 200);
    const c = await getCode();
    assert.equal((await token({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client_id })).status, 400, "sent to /authorize, so required");
  });

  // ---- r4 OAuth security review (.panel-160/r4-oauth-security.md) ----

  test("r4 N1: an ended grant's label is never reused, so a re-approved app with the same name starts on probation", async () => {
    on();
    const save = async (key: string, title: string): Promise<void> => {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_save", arguments: { title, body: "b" } } }),
      });
      assert.equal(r.status, 200, await r.clone().text());
      await r.text();
    };
    const a = await exchange("write");
    await save(a.access, "from grant A");
    const labelA = store.list({ limit: 50 }).notes.find((n) => n.title === "from grant A")!.written_by!;
    assert.match(labelA, /^oauth:Claude/);
    assert.equal(onProbation(store, labelA), true, "a new OAuth app starts on probation");
    confirmWriter(store, labelA, "cli"); // the person vouched for grant A
    const r = await fetch(`${base}/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ token: a.refresh, client_id: a.client_id }) });
    assert.equal(r.status, 200);
    const b = await exchange("write"); // a new app, also calling itself "Claude"
    await save(b.access, "from grant B");
    const labelB = store.list({ limit: 50 }).notes.find((n) => n.title === "from grant B")!.written_by!;
    assert.notEqual(labelB.toLowerCase(), labelA.toLowerCase(), "never the ended grant's label");
    assert.equal(onProbation(store, labelB), true, "the new grant does not inherit grant A's trust record");
    setEnabled(false);
    on();
    const c = await exchange("write");
    await save(c.access, "from grant C");
    const labelC = store.list({ limit: 50 }).notes.find((n) => n.title === "from grant C")!.written_by!;
    assert.ok(![labelA, labelB].map((l) => l.toLowerCase()).includes(labelC.toLowerCase()), "not reused after oauth off/on either");
  });

  test("r4 N3: claude.ai and chatgpt.com are known redirect hosts on the default port only", async () => {
    on();
    for (const bad of ["https://claude.ai:8443/cb", "https://chatgpt.com:444/connector_platform_oauth_redirect"]) {
      const r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: [bad] }) });
      assert.equal(r.status, 400, bad);
    }
    for (const ok of ["https://claude.ai:443/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect"]) {
      const r = await fetch(`${base}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: [ok] }) });
      assert.equal(r.status, 201, ok);
    }
  });

  test("r4 SF-1: an OAuth key is written so Monomem 1.5.x refuses it after a downgrade; 1.6 loads it", async () => {
    on();
    const t = await exchange("write");
    const rows = JSON.parse(readFileSync(join(DATA_DIR, "tokens.json"), "utf8")) as Array<Record<string, unknown>>;
    const row = rows.find((r) => String(r.label).startsWith("oauth:"))!;
    assert.equal(row[OAUTH_KEY_MARKER], true);
    // Monomem 1.5.0's own rule (src/config.ts parseList, v1.5.0): an entry with a key other than max_sensitivity that matches
    // /sens|ceil/i is ignored ("looks like max_sensitivity"). So 1.5.0 never loads this key as a non-expiring REST write key.
    const v150Refuses = (o: Record<string, unknown>): boolean => Object.keys(o).some((k) => k !== "max_sensitivity" && /sens|ceil/i.test(k));
    assert.equal(v150Refuses(row), true);
    assert.equal(v150Refuses(Object.fromEntries(Object.entries(row).filter(([k]) => k !== OAUTH_KEY_MARKER))), false, "the marker is what does it");
    assert.ok(resolveTokens().some((e) => e.label === row.label), "1.6 still loads it");
    assert.equal((await mcpList(t.access)).status, 200);
    // A refresh rewrites the row and keeps the marker.
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.client_id })).status, 200);
    const again = (JSON.parse(readFileSync(join(DATA_DIR, "tokens.json"), "utf8")) as Array<Record<string, unknown>>).find((r) => r.label === row.label)!;
    assert.equal(again[OAUTH_KEY_MARKER], true);
  });

  test("L1: an OAuth key works only on /mcp, not on the REST port", async () => {
    on();
    const t = await exchange("write");
    assert.equal((await mcpList(t.access)).status, 200);
    assert.equal((await fetch(`${apiBase}/notes`, { headers: { Authorization: `Bearer ${t.access}` } })).status, 401);
    const req = { headers: { authorization: `Bearer ${t.access}` } } as unknown as IncomingMessage;
    assert.equal(authenticateEntry(req, tokens), null);
    assert.ok(authenticateEntry(req, tokens, "mcp"));
  });
});
