// Minimal JSON/HTTP API over the shared Store. Deliberately built on plain
// node:http rather than a framework (Express etc.) -- five endpoints don't
// need a router library, and every extra dependency is extra attack
// surface for a service that's about to be exposed over a public tunnel.
//
// Auth: scoped bearer tokens (read/write/admin), checked on every route
// except the open /health and /ready probes and the dashboard page itself.
// Format: `Authorization: Bearer <token>`.

//
// The routes live in src/api/routes-*.ts, the server state they share in src/api/context.ts and the helpers in
// src/api/shared.ts. This file authenticates each request, then tries the route files in a fixed order.

import { createServer, ServerResponse, Server, type IncomingMessage } from "node:http";
import { actorStore, currentWriter } from "./actor.js";
import { Store, ValidationError, NoteUnreadableError } from "./store.js";
import { distrustedOptInRefusal } from "./trust.js";
import { originAllowed, hostAllowed, hostRefusal, clientKey, tokenKey, authenticateEntry, scopeAllows } from "./security.js";
import { type TokenEntry, resolveToken, tokenId, sha256Hex } from "./config.js";
import { PayloadTooLargeError, readBody, applyServerLimits, healthBody, serverProof } from "./http-common.js";
import { DASHBOARD_HTML, DASHBOARD_JS, FAVICON_PNG } from "./dashboard.js";
import { type ServerNamespaceOpts, type NsCtx, NS_DISABLED, resolveRequestNamespace } from "./namespace.js";
import { redeemLogin } from "./login-code.js";
import { randomBytes } from "node:crypto";
import { ORIGIN_DECLARED, ReadTaint, unconfirmedIdsIn } from "./taint.js";
import { SIGN_PAGES, signAsset, DASHBOARD_SESSION_TTL_MS, requiredScope, isReadRoute, pendingReads, sendJson, flagParam } from "./api/shared.js";
import { apiContext, type ApiReq } from "./api/context.js";
import { accountRoutes } from "./api/routes-account.js";
import { noteRoutes } from "./api/routes-notes.js";
import { adminRoutes } from "./api/routes-admin.js";
import { readRoutes } from "./api/routes-read.js";
import { sessionRoutes } from "./api/routes-sessions.js";
import { taskRoutes } from "./api/routes-tasks.js";
import { backupRoutes } from "./api/routes-backup.js";
import { trustRoutes } from "./api/routes-trust.js";
import { uiRoutes, uiAssetRoute, mintLocalSession } from "./api/routes-ui.js";
import { DASHBOARD_CSP } from "./ui/csp.js";
export { DASHBOARD_SESSION_TTL_MS, unknownNoteFields } from "./api/shared.js";

export function createApiServer(
  store: Store,
  token: string | TokenEntry[],
  opts: ServerNamespaceOpts = {}
): Server {
  const c = apiContext(store, token, opts);
  const { tokens, authFailures, tarpit, perToken, taintedReadsFor, dashboardSessions, anon, serverNs, readable } = c;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Per-request namespace context. A LOCAL, not a factory-scoped mutable:
    // this server serves concurrent requests, and a shared `let` would be
    // overwritten by an interleaved request while an earlier one is parked in
    // an await (readBody) -- leaking one token's namespace into another's
    // response. Named `nsCtx` (not `ns`) so it can never be shadowed by the
    // `for (const ns of readable(nsCtx))` loop variables below.
    let nsCtx: NsCtx = serverNs
      ? { active: true, ownNamespace: serverNs.namespace, readsFrom: serverNs.readsFrom }
      : NS_DISABLED;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      // Health check is intentionally unauthenticated so infra (tunnel,
      // uptime monitor) can probe liveness without a credential.
      // Callers without a valid key get {status:"ok"} only; the build and schema need a key (a failed key counts nothing here).
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, healthBody(authenticateEntry(req, tokens) !== null));
        return;
      }

      // Everything past liveness goes through the DNS-rebinding Origin check and
      // the rate limiter first -- including /ready (which touches the DB) and
      // the dashboard, so an unauthenticated client can't hammer either.
      if (!hostAllowed(req)) {
        sendJson(res, 403, hostRefusal(req));
        return;
      }
      if (!originAllowed(req)) {
        sendJson(res, 403, { error: "origin not allowed" });
        return;
      }
      const ip = clientKey(req);
      const anonLimited = (): boolean => {
        if (anon.check(ip)) return false;
        sendJson(res, 429, { error: "rate limit exceeded" });
        return true;
      };

      // Readiness: unlike /health (liveness), this actually touches the DB so
      // an orchestrator/tunnel can tell a half-broken store from a live one.
      if (req.method === "GET" && path === "/ready") {
        if (anonLimited()) return;
        try {
          store.list({ limit: 1 });
          sendJson(res, 200, { status: "ready" });
        } catch {
          sendJson(res, 503, { status: "unavailable" });
        }
        return;
      }

      // GET /proof?nonce=<32 hex> -> { proof }: lets the session-start hook check that this server holds the same main key and
      // store before it sends that key here (recall.ts askServerForBodyHits). An HMAC only: no key, no note data.
      if (req.method === "GET" && path === "/proof") {
        if (anonLimited()) return;
        const nonce = url.searchParams.get("nonce") ?? "";
        const primary = tokens.find((t) => t.label === "primary");
        if (!primary) {
          sendJson(res, 404, { error: "this server has no main key" });
          return;
        }
        if (!/^[0-9a-f]{32}$/.test(nonce)) {
          sendJson(res, 400, { error: "nonce must be 32 lowercase hex characters" });
          return;
        }
        sendJson(res, 200, { proof: serverProof(tokenId(primary), nonce, store.storeId()) });
        return;
      }

      // Dashboard UI (no data in the page itself; its fetches carry the token).
      if (req.method === "GET" && (path === "/" || path === "/ui")) {
        if (anonLimited()) return;
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          // Self-contained page: no external loads, no framing. Scripts run only from /dashboard.js (no inline handlers:
          // buttons use data-do attributes and one dispatcher, src/ui/js-actions.ts). Styles may be inline.
          "Content-Security-Policy": DASHBOARD_CSP,
        });
        res.end(DASHBOARD_HTML);
        return;
      }
      // The tab icon: the brand mark, no token (browsers ask for it without credentials).
      if (req.method === "GET" && path === "/favicon.ico") {
        if (anonLimited()) return;
        res.writeHead(200, {
          "Content-Type": "image/png",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "public, max-age=86400",
        });
        res.end(FAVICON_PNG);
        return;
      }
      // The installable-app files (manifest, icons): no key, no data (routes-ui.ts).
      if (uiAssetRoute(req, res, path, anonLimited)) return;
      if (req.method === "GET" && path === "/dashboard.js") {
        if (anonLimited()) return;
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(DASHBOARD_JS);
        return;
      }
      // POST /login {code} -> {token}: trades the one-time code `monomem open` put in the address for the key (login-code.ts).
      if (req.method === "POST" && path === "/login") {
        if (anonLimited()) return;
        let code: unknown;
        try {
          code = (JSON.parse((await readBody(req)) || "{}") as { code?: unknown }).code;
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const redeemed = redeemLogin(code);
        if (!redeemed) {
          sendJson(res, 401, { error: "that sign-in link has expired or was already used. Run monomem open again." });
          return;
        }
        const key = resolveToken();
        if (!redeemed.terminal) {
          sendJson(res, 200, { token: key, local_session: mintLocalSession(), notice: "Signed in. Confirms here count as the key's, because this link wasn't opened from a terminal." });
          return;
        }
        const session = randomBytes(24).toString("hex");
        const label = tokens.find((t) => tokenId(t) === sha256Hex(key))?.label ?? "";
        dashboardSessions.set(session, { label, exp: Date.now() + DASHBOARD_SESSION_TTL_MS });
        if (dashboardSessions.size > 100) dashboardSessions.delete(dashboardSessions.keys().next().value as string);
        sendJson(res, 200, { token: key, dashboard_session: session, local_session: mintLocalSession() });
        return;
      }
      // Phone command signer. No data in it; the secret never leaves the phone,
      // and its POST still needs a bearer token like any other write.
      if (req.method === "GET" && SIGN_PAGES[path]) {
        if (anonLimited()) return;
        const asset = SIGN_PAGES[path];
        const body = signAsset(asset.file);
        if (body === null) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": asset.type,
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end(body);
        return;
      }

      const principal = authenticateEntry(req, tokens);
      if (!principal) {
        // Only failed authentications count toward the per-IP limit.
        // Escalating delay on repeated failures (valid tokens never reach here).
        const proceed = await tarpit.failed(ip);
        if (!proceed || !authFailures.check(ip)) sendJson(res, 429, { error: "rate limit exceeded" });
        else sendJson(res, 401, { error: "unauthorized", hint: "Send your key as the header  Authorization: Bearer <key>.  Your keys: monomem keys list.  To open the dashboard already signed in: monomem open" });
        return;
      }
      if (!perToken.check(tokenKey(tokenId(principal)))) {
        sendJson(res, 429, { error: "rate limit exceeded" });
        return;
      }
      const scope = principal.scope;
      const actorRef = actorStore.getStore();
      if (actorRef) {
        actorRef.label = principal.label;
        actorRef.authed = true; // written_by is the verified token label
        // The token's sensitivity ceiling rides on the same per-request context, and the store applies it inside its queries.
        if (principal.max_sensitivity !== undefined) actorRef.maxSensitivity = principal.max_sensitivity;
        actorRef.canDeclassify = scopeAllows(principal.scope, "admin");
        // 1.4.0 taint: what this token read while unconfirmed (kept per token for the process), and its declared flag.
        const reads = taintedReadsFor(currentWriter());
        actorRef.taintedReads = reads;
        actorRef.taint = principal.reads_outside ? [ORIGIN_DECLARED] : []; // via:memory is decided by the Store from taintedReads
      } else if (principal.max_sensitivity !== undefined) {
        // Cannot happen (every request runs inside actorStore.run), but a ceiling that cannot be applied must never be skipped.
        sendJson(res, 500, { error: "internal error" });
        return;
      }
      // Per-request namespace: a token's own pin WINS over the server's
      // cwd-resolved namespace. This is the isolation boundary for this
      // request -- resolved here, once, so every gate below reads `ns`.
      nsCtx = resolveRequestNamespace(principal.namespace, serverNs);
      // 1.4.0: a write's derived_from may only name notes this request could read (Store.derivedIds).
      if (actorRef && nsCtx.active) actorRef.readable = readable(nsCtx);
      // Enforce the token's scope: a read-only token can't write/delete, etc.
      const need = requiredScope(req.method, path);
      if (!scopeAllows(scope, need)) {
        sendJson(res, 403, {
          error: `this token lacks the required '${need}' scope`,
          hint:
            need === "admin"
              ? "This needs an administrator key. Make one with: monomem keys add <name> --admin"
              : "This app's key can only read. Make a key that can also write with: monomem keys add <name> --scope write",
        });
        return;
      }
      // Read access log: the preview is the search text when there is one, else the query string (POST bodies set it below).
      let readQuery: unknown = url.searchParams.get("q") ?? url.searchParams.get("query") ?? (url.search.slice(1) || undefined);
      if (isReadRoute(req.method, path)) {
        const nsHint = url.searchParams.get("namespace");
        const tool = `${req.method} ${path.replace(/\/\d+(?=\/|$)/g, "/:id").replace(/^\/sessions\/[^/]+$/, "/sessions/:id")}`;
        pendingReads.set(res, (payload) => {
          // 1.4.0: an unconfirmed note handed to this token: what it writes next is marked via:memory.
          const reads = actorRef?.taintedReads;
          if (reads instanceof ReadTaint) for (const id of unconfirmedIdsIn(payload)) reads.add(id);
          store.logAccess({ tool, namespaces: nsHint ? [nsHint] : [], query: readQuery, payload });
        });
      } else if (actorRef && !(req.method === "POST" && /^\/(notes|tasks|handoffs)$/.test(path))) {
        // R1-05: any other reply that carries an unconfirmed note (PUT /notes/:id, POST /tasks/:id/claim ...) marks the token too.
        // Creating routes are left out: the note in their reply is the caller's own. No access-log row for these.
        pendingReads.set(res, (payload) => {
          const reads = actorRef.taintedReads;
          if (reads instanceof ReadTaint) for (const id of unconfirmedIdsIn(payload)) reads.add(id);
        });
      }

      // include_distrusted switches the trust policy OFF for the call, so it is an
      // admin decision: a read or write token (or an agent holding one that a hostile
      // note talked into asking) gets a clear refusal, never the hidden notes.
      const isAdmin = scopeAllows(scope, "admin");
      // A namespace-PINNED admin manages the rules of its OWN namespace only; the namespaces it merely has read grants on
      // belong to their own admins, so the opt-in is honoured for the token's own namespace and nowhere else (it must say
      // so with namespace=<own>, or name a note of its own namespace by id).
      const pinnedWithGrants = (): boolean => nsCtx.active && readable(nsCtx).some((n) => n !== nsCtx.ownNamespace);
      // The rule itself is distrustedOptInRefusal (trust.ts), shared with MCP; this maps its answer to a 403.
      const refuseDistrustedOptIn = (nsHint?: string | null, byId = false): boolean => {
        const why = distrustedOptInRefusal({ admin: isAdmin, byId, pinnedWithGrants, ownNs: nsCtx.ownNamespace, nsHint: nsHint ?? "" });
        if (why === null) return false;
        sendJson(res, 403, {
          error:
            why === "other-namespace"
              ? `include_distrusted is honoured only for this token's own namespace ("${nsCtx.ownNamespace}"): pass namespace=${nsCtx.ownNamespace}. ` +
                "The namespaces this token can only read are governed by their own admins."
              : "include_distrusted needs an admin key: it shows notes from writers the admin put on the distrust list",
        });
        return true;
      };
      // (By-id reads carry no namespace parameter: they are checked against the note's own namespace where they read it.)
      const byIdRead = req.method === "GET" && (/^\/notes\/\d+$/.test(path) || /^\/tasks\/\d+$/.test(path));
      if (flagParam(url, "include_distrusted") && refuseDistrustedOptIn(byIdRead ? null : url.searchParams.get("namespace"), byIdRead)) return;

      const r: ApiReq = {
        req,
        res,
        url,
        path,
        ip,
        anonLimited,
        principal,
        scope,
        actorRef,
        need,
        nsCtx,
        isAdmin,
        pinnedWithGrants,
        refuseDistrustedOptIn,
        byIdRead,
        setReadQuery: (q) => {
          readQuery = q;
        },
      };
      if (await accountRoutes(c, r)) return;
      if (await noteRoutes(c, r)) return;
      if (await adminRoutes(c, r)) return;
      if (await readRoutes(c, r)) return;
      if (await sessionRoutes(c, r)) return;
      if (await taskRoutes(c, r)) return;
      if (await backupRoutes(c, r)) return;
      if (await trustRoutes(c, r)) return;
      if (await uiRoutes(c, r)) return;

      sendJson(res, 404, { error: "no such route" });
    } catch (e) {
      // A body over the 1MB cap is a client problem -> 413, not a generic 500.
      if (e instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: "payload too large" });
        return;
      }
      // A body that cannot be decrypted names the note (clear, actionable,
      // contains no content) instead of a bare "internal error".
      if (e instanceof NoteUnreadableError) {
        console.error("[monomem] " + e.message);
        sendJson(res, 500, { error: e.message, id: e.noteId });
        return;
      }
      // A refusal written for the caller (a search that is too long, a bad value) is a 400 with its own words.
      if (e instanceof ValidationError) {
        sendJson(res, 400, { error: e.message });
        return;
      }
      // Log details server-side; never leak internals (SQL errors, paths) out.
      console.error("[monomem] request error:", (e as Error).message);
      sendJson(res, 500, { error: "internal error" });
    }
  };
  // Every request gets its own actor holder; the label is filled in once the
  // token is authenticated, so change_log records who actually wrote.
  return applyServerLimits(createServer((req, res) => {
    void actorStore.run({ label: "" }, () => handle(req, res));
  }));
}
