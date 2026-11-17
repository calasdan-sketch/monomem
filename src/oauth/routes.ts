// OAuth 2.1 authorization server for claude.ai / ChatGPT remote MCP connectors, on the MCP-over-HTTP port, on node:http
// (not the SDK's Express router). Off by default: until `monomem oauth on <https url>`, every route here answers 404.
//
// What it follows (cited in docs/oauth.md): MCP authorization 2026-07-28 (RFC 9728 protected resource metadata, RFC 8414
// server metadata, RFC 7591 registration, PKCE S256 only, RFC 8707 resource, RFC 9207 `iss` in every authorization
// response), plus what claude.ai and ChatGPT document: public clients (token auth "none"), form-encoded /token, refresh
// rotation, `invalid_grant` for a dead refresh token, loopback redirects matched with any port.
//
// The person gate is a one-time pairing code shown by `monomem oauth pair` at the terminal: no code, no grant.
// A grant becomes an ordinary tokens.json key (label "oauth:<client name>", scope read or write, never admin, ceiling
// internal, reads_outside), so the namespace, ceiling, taint, writer stamp, rate limit and audit rules apply unchanged.
// Secrets (codes, keys, refresh tokens, pairing codes) are never logged; only their sha256 is stored.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readBody, PayloadTooLargeError } from "../http-common.js";
import { RateLimiter, AuthTarpit, clientKey, audit } from "../security.js";
import { isLoopback, type TokenEntry } from "../config.js";
import { DEFAULT_SENSITIVITY } from "../sensitivity.js";
import { setOAuthKey, takenLabels } from "../tokens-admin.js";
import { clock, readState, updateState, usePairCode, sha256, CLIENT_UNUSED_TTL_MS, MAX_CLIENTS, type OAuthClient, type OAuthGrant, type OAuthState } from "./state.js";
import { consentHtml, errorHtml } from "./consent.js";

export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const CODE_TTL_MS = 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const MAX_PENDING = 200;
const CSRF_COOKIE = "mm_oauth_csrf";

const PRM_PATHS = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];
const AS_PATH = "/.well-known/oauth-authorization-server";
const ROUTES = new Set([...PRM_PATHS, AS_PATH, "/register", "/authorize", "/token", "/revoke"]);

interface Pending { client_id: string; redirect_uri: string; challenge: string; state: string | null; scope: "read" | "write"; csrf: string; exp: number; fails: number }
interface Code { client_id: string; redirect_uri: string; challenge: string; scope: "read" | "write"; exp: number }

const freshLimits = () => ({
  token: new RateLimiter(30, 60_000),
  authorize: new RateLimiter(60, 60_000),
  register: new RateLimiter(10, 600_000),
  tarpit: new AuthTarpit(),
});
let limits = freshLimits();
const pending = new Map<string, Pending>(); // request id -> consent request waiting for the person
const codes = new Map<string, Code>(); // sha256(code) -> authorization code (memory only, 60 s, single use)

/** Tests: forget codes, consent requests and rate-limit counters. */
export function resetOAuthMemory(): void {
  pending.clear();
  codes.clear();
  limits = freshLimits();
}

const rand = (n: number): string => randomBytes(n).toString("base64url");
const b64sha = (s: string): string => createHash("sha256").update(s).digest("base64url");
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(sha256(a), "hex"), Buffer.from(sha256(b), "hex"));
const resourceOf = (issuer: string): string => issuer + "/mcp";

/** The WWW-Authenticate value for a 401 on /mcp while OAuth is on; undefined while off. */
export function oauthChallenge(): string | undefined {
  const s = readState();
  return s.enabled && s.issuer ? `Bearer resource_metadata="${s.issuer}/.well-known/oauth-protected-resource/mcp"` : undefined;
}

function send(res: ServerResponse, status: number, body: string, type: string, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}
const json = (res: ServerResponse, status: number, body: unknown): void => send(res, status, JSON.stringify(body), "application/json");
const oauthError = (res: ServerResponse, status: number, error: string, description?: string): void =>
  json(res, status, { error, ...(description ? { error_description: description } : {}) });
const HTML_HEADERS = { "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" };
const htmlError = (res: ServerResponse, status: number, msg: string): void =>
  send(res, status, errorHtml(msg), "text/html; charset=utf-8", { ...HTML_HEADERS, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });

/** Redirect back to a redirect URI that already matched a registered one; adds iss (RFC 9207) and state. */
function redirect(res: ServerResponse, to: string, params: Record<string, string | null>, issuer: string): void {
  const u = new URL(to);
  for (const [k, v] of Object.entries({ ...params, iss: issuer })) if (v !== null && v !== undefined) u.searchParams.set(k, v);
  send(res, 302, "", "text/plain", { Location: u.toString() });
}

const loopbackHost = (h: string): boolean => h === "localhost" || isLoopback(h.replace(/^\[|\]$/g, ""));

/** Registration: https, or http to this computer (RFC 8252). No fragment, no user name. */
function redirectAllowed(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length > 512) return false;
  try {
    const u = new URL(raw);
    if (u.hash || u.username || u.password) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && loopbackHost(u.hostname));
  } catch {
    return false;
  }
}

/** Exact string match; a loopback http redirect matches with any port (RFC 8252 section 7.3; Claude Code needs it). */
function redirectMatches(client: OAuthClient, given: string): boolean {
  if (client.redirect_uris.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  return client.redirect_uris.some((r) => {
    const u = new URL(r);
    return u.protocol === "http:" && loopbackHost(u.hostname) && g.protocol === "http:" && g.hostname === u.hostname && g.pathname === u.pathname && g.search === u.search && !g.hash && !g.username;
  });
}

/** RFC 8707: a resource, when sent, must name this server (its /mcp URL or its origin). */
function resourceOk(given: string | null, issuer: string): boolean {
  if (!given) return true;
  try {
    const u = new URL(given);
    const s = (u.origin + u.pathname).replace(/\/$/, "").toLowerCase();
    return s === issuer.toLowerCase() || s === resourceOf(issuer).toLowerCase();
  } catch {
    return false;
  }
}

function metadata(issuer: string, path: string): unknown {
  if (path === AS_PATH) {
    return {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "write"],
      authorization_response_iss_parameter_supported: true,
    };
  }
  return { resource: resourceOf(issuer), authorization_servers: [issuer], scopes_supported: ["read", "write"], bearer_methods_supported: ["header"], resource_name: "Monomem" };
}

/** "oauth:<client name>", made unique. A colon cannot appear in a `monomem keys add` name, so no other key can pose as one. */
function grantLabel(clientName: string): string {
  const base = "oauth:" + (clientName.replace(/[^\w .-]/g, "").replace(/\s+/g, " ").trim().slice(0, 32) || "app");
  const taken = takenLabels();
  let label = base;
  for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${base}-${n}`;
  return label;
}

function setLive(tokens: TokenEntry[], label: string, entry: TokenEntry | null): void {
  const i = tokens.findIndex((t) => t.label === label);
  if (i >= 0) tokens.splice(i, 1);
  if (entry) tokens.push(entry);
}

/** Make a fresh key pair for a grant: writes the access key's hash into tokens.json and the live list. */
function mintAccess(tokens: TokenEntry[], label: string, scope: "read" | "write", mustExist: boolean): { access: string; refresh: string } | null {
  const access = randomBytes(32).toString("hex");
  const refresh = randomBytes(32).toString("hex");
  const expires_at = new Date(clock.now() + ACCESS_TTL_S * 1000).toISOString();
  const token_sha256 = sha256(access);
  if (!setOAuthKey(label, { token_sha256, scope, expires_at }, mustExist)) return null;
  setLive(tokens, label, { token_sha256, scope, label, max_sensitivity: DEFAULT_SENSITIVITY, reads_outside: true, expires_at });
  return { access, refresh };
}

const tokenReply = (res: ServerResponse, k: { access: string; refresh: string }, scope: string): void =>
  json(res, 200, { access_token: k.access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: k.refresh, scope });

/** Drop a grant and its key (inside updateState). */
function dropGrant(s: OAuthState, g: OAuthGrant, tokens: TokenEntry[], why: string): OAuthState {
  setOAuthKey(g.label, null);
  setLive(tokens, g.label, null);
  audit({ op: "oauth.revoke", label: g.label, kind: "token", detail: why });
  return { ...s, grants: s.grants.filter((x) => x !== g) };
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req, 16_384));
}

/**
 * Handle an OAuth route. Returns false when the path is not an OAuth route (the caller goes on); true when answered.
 * Runs after the Host check and before the Origin check: the consent form posts from the public origin, which the
 * MCP Origin allowlist would refuse; /authorize POST checks its own Origin instead.
 */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, url: URL, tokens: TokenEntry[]): Promise<boolean> {
  if (!ROUTES.has(url.pathname)) return false;
  const st = readState();
  if (!st.enabled || !st.issuer) {
    json(res, 404, { error: "no such route" });
    return true;
  }
  const issuer = st.issuer;
  try {
    if (PRM_PATHS.includes(url.pathname) || url.pathname === AS_PATH) {
      if (req.method !== "GET") json(res, 405, { error: "method not allowed" });
      else json(res, 200, metadata(issuer, url.pathname));
    } else if (url.pathname === "/register" && req.method === "POST") await register(req, res);
    else if (url.pathname === "/authorize" && req.method === "GET") authorizeGet(req, res, url, st);
    else if (url.pathname === "/authorize" && req.method === "POST") await authorizePost(req, res, st);
    else if (url.pathname === "/token" && req.method === "POST") await token(req, res, tokens, issuer);
    else if (url.pathname === "/revoke" && req.method === "POST") await revoke(req, res, tokens);
    else json(res, 405, { error: "method not allowed" });
  } catch (e) {
    if (e instanceof PayloadTooLargeError) json(res, 413, { error: "payload too large" });
    else {
      console.error("[monomem] oauth error on", url.pathname, "-", (e as Error).message); // never the request: it carries secrets
      json(res, 500, { error: "server_error" });
    }
  }
  return true;
}

async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!limits.register.check(clientKey(req))) return oauthError(res, 429, "too_many_requests");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req, 16_384)) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
  } catch {
    return oauthError(res, 400, "invalid_client_metadata", "body must be a JSON object");
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(redirectAllowed)) {
    return oauthError(res, 400, "invalid_redirect_uri", "1 to 5 redirect URIs, each https or http to localhost, without a #fragment");
  }
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "app";
  const now = clock.now();
  const client: OAuthClient = { client_id: "mmc_" + randomBytes(16).toString("hex"), client_name: name, redirect_uris: uris as string[], created_at: now };
  const ok = updateState((s) => {
    const used = new Set(s.grants.map((g) => g.client_id));
    let clients = s.clients.filter((c) => used.has(c.client_id) || now - c.created_at < CLIENT_UNUSED_TTL_MS);
    // Full: make room by dropping the oldest client nobody approved.
    while (clients.length >= MAX_CLIENTS) {
      const i = clients.findIndex((c) => !used.has(c.client_id));
      if (i < 0) return { next: s, result: false };
      clients = clients.filter((_, j) => j !== i);
    }
    return { next: { ...s, clients: [...clients, client] }, result: true };
  });
  if (!ok) return oauthError(res, 400, "invalid_client_metadata", "too many connected apps; remove one with monomem keys remove");
  json(res, 201, {
    client_id: client.client_id,
    client_id_issued_at: Math.floor(now / 1000),
    client_name: name,
    redirect_uris: client.redirect_uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
}

function authorizeGet(req: IncomingMessage, res: ServerResponse, url: URL, st: OAuthState): void {
  if (!limits.authorize.check(clientKey(req))) return htmlError(res, 429, "Too many tries. Wait a minute and start again from the app.");
  const q = url.searchParams;
  const client = st.clients.find((c) => c.client_id === q.get("client_id"));
  const to = q.get("redirect_uri") ?? (client?.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  // An unknown app or an address it did not register: show an error here, never send the browser anywhere.
  if (!client || !to || !redirectMatches(client, to)) return htmlError(res, 400, "This sign-in link is not valid (unknown app, or an address the app did not register). Start again from the app.");
  const state = q.get("state");
  const fail = (error: string, desc: string): void => redirect(res, to, { error, error_description: desc, state }, st.issuer!);
  if (q.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  if (!resourceOk(q.get("resource"), st.issuer!)) return fail("invalid_target", "resource must be this server");
  const now = clock.now();
  for (const [k, p] of pending) if (p.exp < now) pending.delete(k);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  const requestId = rand(24);
  const csrf = rand(32);
  const scope = (q.get("scope") ?? "").split(/\s+/).includes("write") ? "write" : "read";
  pending.set(requestId, { client_id: client.client_id, redirect_uri: to, challenge, state, scope, csrf, exp: now + REQUEST_TTL_MS, fails: 0 });
  showConsent(res, requestId, pending.get(requestId)!, client, st.issuer!, 200);
}

function showConsent(res: ServerResponse, requestId: string, p: Pending, client: OAuthClient, issuer: string, status: number, error?: string): void {
  const to = new URL(p.redirect_uri);
  const secure = issuer.startsWith("https:") ? "; Secure" : "";
  send(res, status, consentHtml({ requestId, csrf: p.csrf, clientName: client.client_name, redirectHost: to.host, loopback: loopbackHost(to.hostname), scope: p.scope, error }), "text/html; charset=utf-8", {
    ...HTML_HEADERS,
    // form-action must also allow the app's address: browsers apply it to the redirect after the form is sent.
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${to.origin}; frame-ancestors 'none'; base-uri 'none'`,
    "Set-Cookie": `${CSRF_COOKIE}=${p.csrf}; Path=/authorize; HttpOnly; SameSite=Strict; Max-Age=600${secure}`,
  });
}

function cookie(req: IncomingMessage, name: string): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

async function authorizePost(req: IncomingMessage, res: ServerResponse, st: OAuthState): Promise<void> {
  const ckey = clientKey(req);
  if (!limits.authorize.check(ckey)) return htmlError(res, 429, "Too many tries. Wait a minute and start again from the app.");
  // CSRF: the form must come from this page (same origin) and carry the cookie set with it.
  const origin = req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  if ((typeof origin === "string" && origin !== st.issuer) || (typeof site === "string" && site !== "same-origin" && site !== "none")) {
    return htmlError(res, 403, "This form was sent from another site, so it was refused.");
  }
  const f = await form(req);
  const requestId = f.get("request_id") ?? "";
  const p = pending.get(requestId);
  if (!p || p.exp < clock.now()) return htmlError(res, 400, "This page expired. Start again from the app.");
  const given = f.get("csrf") ?? "";
  if (!given || !sameSecret(given, p.csrf) || !sameSecret(cookie(req, CSRF_COOKIE), p.csrf)) {
    return htmlError(res, 403, "This form could not be checked (cookie missing or wrong). Start again from the app.");
  }
  const client = st.clients.find((c) => c.client_id === p.client_id);
  if (!client) return htmlError(res, 400, "This app is no longer registered. Start again from the app.");
  if (f.get("action") === "deny") {
    pending.delete(requestId);
    return redirect(res, p.redirect_uri, { error: "access_denied", error_description: "the person said no", state: p.state }, st.issuer!);
  }
  const scope = f.get("scope");
  if (scope !== "read" && scope !== "write") return htmlError(res, 400, "Choose read or read and write.");
  const pair = (f.get("pair_code") ?? "").trim();
  if (!pair) return showConsent(res, requestId, p, client, st.issuer!, 400, "Type the pairing code from monomem oauth pair.");
  if (!usePairCode(pair)) {
    await limits.tarpit.failed(ckey);
    p.fails += 1;
    if (p.fails >= 5) {
      pending.delete(requestId);
      return htmlError(res, 400, "Too many wrong codes. Start again from the app, and make a new code with monomem oauth pair.");
    }
    return showConsent(res, requestId, p, client, st.issuer!, 400, "That code is wrong or expired. Make a new one with monomem oauth pair.");
  }
  pending.delete(requestId);
  const code = rand(32);
  const now = clock.now();
  for (const [k, c] of codes) if (c.exp < now) codes.delete(k);
  codes.set(sha256(code), { client_id: client.client_id, redirect_uri: p.redirect_uri, challenge: p.challenge, scope, exp: now + CODE_TTL_MS });
  redirect(res, p.redirect_uri, { code, state: p.state }, st.issuer!);
}

async function token(req: IncomingMessage, res: ServerResponse, tokens: TokenEntry[], issuer: string): Promise<void> {
  if (!limits.token.check(clientKey(req))) return oauthError(res, 429, "too_many_requests");
  const f = await form(req);
  const clientId = f.get("client_id") ?? "";
  const grantType = f.get("grant_type");
  if (grantType === "authorization_code") {
    const key = sha256(f.get("code") ?? "");
    const c = codes.get(key);
    codes.delete(key); // single use, even when the rest of the request is wrong
    const verifier = f.get("code_verifier") ?? "";
    if (!c || clock.now() > c.exp || c.client_id !== clientId || f.get("redirect_uri") !== c.redirect_uri) return oauthError(res, 400, "invalid_grant");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameSecret(b64sha(verifier), c.challenge)) return oauthError(res, 400, "invalid_grant", "PKCE check failed");
    if (!resourceOk(f.get("resource"), issuer)) return oauthError(res, 400, "invalid_target");
    const client = readState().clients.find((x) => x.client_id === clientId);
    if (!client) return oauthError(res, 400, "invalid_client");
    const label = grantLabel(client.client_name);
    const k = mintAccess(tokens, label, c.scope, false)!;
    const now = clock.now();
    const grant: OAuthGrant = { label, client_id: clientId, scope: c.scope, refresh_sha256: sha256(k.refresh), refresh_exp: now + REFRESH_TTL_MS, used_refresh: [], created_at: now, refreshed_at: now, redirect_host: new URL(c.redirect_uri).host };
    updateState((s) => ({ next: { ...s, grants: [...s.grants, grant] }, result: undefined }));
    audit({ op: "oauth.grant", label, kind: "token", detail: `scope=${c.scope} to=${grant.redirect_host}` });
    return tokenReply(res, k, c.scope);
  }
  if (grantType === "refresh_token") {
    const h = sha256(f.get("refresh_token") ?? "");
    const out = updateState((s): { next: OAuthState; result: { access: string; refresh: string; scope: string } | null } => {
      const g = s.grants.find((x) => x.refresh_sha256 === h);
      if (!g) {
        // An old refresh token coming back means someone kept a copy: end the whole grant (OAuth 2.1 section 4.3.1).
        const reused = s.grants.find((x) => x.used_refresh.includes(h));
        return { next: reused ? dropGrant(s, reused, tokens, "refresh token reused") : s, result: null };
      }
      if (g.client_id !== clientId) return { next: s, result: null };
      if (clock.now() > g.refresh_exp) return { next: dropGrant(s, g, tokens, "refresh token expired"), result: null };
      const k = mintAccess(tokens, g.label, g.scope, true);
      if (!k) {
        // The person removed the key (monomem keys remove / dashboard): the grant ends with it.
        audit({ op: "oauth.revoke", label: g.label, kind: "token", detail: "key removed by the person" });
        return { next: { ...s, grants: s.grants.filter((x) => x !== g) }, result: null };
      }
      const now = clock.now();
      const next: OAuthGrant = { ...g, refresh_sha256: sha256(k.refresh), refresh_exp: now + REFRESH_TTL_MS, used_refresh: [...g.used_refresh, h].slice(-20), refreshed_at: now };
      return { next: { ...s, grants: s.grants.map((x) => (x === g ? next : x)) }, result: { ...k, scope: g.scope } };
    });
    if (!out) return oauthError(res, 400, "invalid_grant");
    return tokenReply(res, out, out.scope);
  }
  return oauthError(res, 400, "unsupported_grant_type");
}

/** RFC 7009: always 200, whether or not the token was known. */
async function revoke(req: IncomingMessage, res: ServerResponse, tokens: TokenEntry[]): Promise<void> {
  if (!limits.token.check(clientKey(req))) return oauthError(res, 429, "too_many_requests");
  const f = await form(req);
  const h = sha256(f.get("token") ?? "");
  const clientId = f.get("client_id") ?? "";
  const byAccess = tokens.find((t) => t.token_sha256 === h && t.label.startsWith("oauth:"))?.label;
  updateState((s) => {
    const g = s.grants.find((x) => (x.refresh_sha256 === h || x.label === byAccess) && x.client_id === clientId);
    return { next: g ? dropGrant(s, g, tokens, "revoked by the app") : s, result: undefined };
  });
  json(res, 200, {});
}

/** For `monomem oauth list`. */
export function grantsForList(): Array<OAuthGrant & { client_name: string }> {
  const s = readState();
  return s.grants.map((g) => ({ ...g, client_name: s.clients.find((c) => c.client_id === g.client_id)?.client_name ?? "(gone)" }));
}
