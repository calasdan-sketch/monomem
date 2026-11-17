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
import { DATA_DIR, resolveTokens, type TokenEntry } from "../src/config.js";
import { listApps, removeApp } from "../src/tokens-admin.js";
import { clock, newPairCode, readState, setEnabled } from "../src/oauth/state.js";
import { resetOAuthMemory } from "../src/oauth/routes.js";

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

  before(async () => {
    store = new Store(":memory:");
    tokens = [{ token: ADMIN, scope: "admin", label: "primary" }];
    server = createMcpHttpServer(store, tokens);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
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

  test("no pairing code, no grant; a wrong code fails and five wrong codes burn the code", async () => {
    on();
    const client_id = await register();
    const page = await consentPage(authorizeUrl(client_id, pkce().challenge));
    assert.equal((await consent(page, { scope: "read" })).status, 400);
    const code = newPairCode();
    for (let i = 0; i < 5; i++) assert.equal((await consent(page, { pair_code: "WRONG-CODE", scope: "read" })).status, 400);
    const page2 = await consentPage(authorizeUrl(client_id, pkce().challenge));
    const r = await consent(page2, { pair_code: code, scope: "read" });
    assert.equal(r.status, 400, "the burned code no longer works");
    assert.equal(readState().pair, undefined);
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
});
