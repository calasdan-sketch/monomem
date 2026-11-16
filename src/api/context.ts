// The REST server's shared state (keys, rate limiters, dashboard sessions, namespace helpers) and the per-request facts
// the routes use. Split out of createApiServer (api.ts) unchanged; the route files under src/api/ take them as `c` and `r`.

import { ServerResponse, type IncomingMessage } from "node:http";
import { Store, NoteRecord } from "../store.js";
import { RateLimiter, AuthTarpit } from "../security.js";
import type { Scope, TokenEntry } from "../config.js";
import { normalizeTokens } from "../http-common.js";
import { type ServerNamespaceOpts, type ResolvedNamespace, type NsCtx, readableIn, ctxCanRead } from "../namespace.js";
import { annotateStaleness } from "../staleness.js";
import { withDisputes } from "../facts.js";
import { taintRegistryFor } from "../taint.js";
import { sendJson, WriterFilter, SupersededFilter } from "./shared.js";
import type { ActorRef } from "../actor.js";

export function apiContext(store: Store, token: string | TokenEntry[], opts: ServerNamespaceOpts) {
  const tokens = normalizeTokens(token);
  /** A note for a read reply: staleness and (R2-01) the dispute marker, computed inside the caller's request. */
  const annotRead = (n: NoteRecord) => withDisputes(store, annotateStaleness(n) as NoteRecord);
  // Two buckets, neither of which lets garbage traffic lock out a valid
  // client sharing its IP (everyone behind one tunnel has the same socket IP):
  //  - authFailures: per client IP, counts FAILED authentications only
  //    (brute-force defence);
  //  - perToken: per authenticated token, counts that token's requests;
  //  - anon: per IP, for the few unauthenticated routes (/ready, dashboard).
  const authFailures = new RateLimiter();
  const tarpit = new AuthTarpit();
  const perToken = new RateLimiter();
  // 1.4.0: unconfirmed notes each token has read, kept across its requests and shared with MCP over HTTP (taint.ts).
  const taintedReadsFor = taintRegistryFor(store);
  // 1.4.0: dashboard sessions opened with `monomem open` AT A TERMINAL (POST /login with its one-time code; login-code.ts
  // records where it was minted). The dashboard sends one back in X-Monomem-Dashboard; only then is an admin confirm treated
  // as the person looking at the note (Store.confirm `dashboard`). Each is bound to the key it signed in as and lasts
  // DASHBOARD_SESSION_TTL_MS. Any other admin key, the primary one included, is an agent as far as the read rule goes.
  // ponytail: in memory, newest 100; a restart signs the dashboard's confirm out of that exemption until monomem open again.
  const dashboardSessions = new Map<string, { label: string; exp: number }>();
  const anon = new RateLimiter();

  // Server-side namespace resolution, active only when the entry point
  // resolved a namespace at startup (see resolveStartupNamespace), OR when
  // the AUTHENTICATED TOKEN carries a namespace pin.
  //
  // Per-token pinning is what makes one shared bridge safe for several
  // agents: `resolveRequestNamespace` runs per REQUEST (not per process), so
  // a token pinned to "work" is confined to "work" even though the server
  // process resolved a different namespace from its cwd. Tokens with no pin
  // fall back to the server's resolution -- byte-identical legacy behavior.
  const serverNs: ResolvedNamespace | null =
    typeof opts.namespace === "string" && opts.namespace.length > 0
      ? { namespace: opts.namespace, readsFrom: opts.readsFrom ?? {} }
      : null;

  // The request-scoped namespace context is NOT declared here: it lives as a
  // local inside each request handler (see `ns` below), because this server
  // handles CONCURRENT requests and a factory-scoped `let` mutated per
  // request would be clobbered by an interleaved request while an earlier one
  // sits in an `await` -- which is exactly the cross-namespace leak per-token
  // pinning exists to prevent. The helpers below take the context as their
  // first argument for the same reason.

  const readable = (ctx: NsCtx): string[] => readableIn(ctx);
  const trustedHint = (ctx: NsCtx, hint: string | undefined): string | undefined =>
    hint && ctxCanRead(ctx, hint) ? hint : undefined;
  // 404 helper for a note outside the readable set (or missing): a distinct
  // 403 would let the caller probe which ids exist in other namespaces.
  // When namespace resolution is inactive there is no readable set to
  // enforce -- every note is readable (legacy behavior).
  const denyUnreadable = (
    ctx: NsCtx,
    res: ServerResponse,
    note: NoteRecord | null
  ): note is NoteRecord => {
    if (!note) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    if (ctx.active && !ctxCanRead(ctx, note.namespace)) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    return true;
  };
  // Write/delete access never crosses namespaces: the note must live in the
  // request's own namespace (a read grant confers no write access). Uniform
  // 404 again, so cross-namespace writes are no existence oracle either.
  const denyUnwritable = (
    ctx: NsCtx,
    res: ServerResponse,
    note: NoteRecord | null
  ): note is NoteRecord => {
    if (!note || note.namespace !== ctx.ownNamespace) {
      sendJson(res, 404, { error: "not found" });
      return false;
    }
    return true;
  };
  // List across every readable namespace, newest-first like store.list,
  // paged in SQL so total and deep offsets are exact.
  const listReadable = (
    ctx: NsCtx,
    limit?: number,
    offset?: number,
    includeArchived?: boolean,
    archivedOnly?: boolean,
    wf: WriterFilter & SupersededFilter = {}
  ): { notes: NoteRecord[]; total: number } =>
    store.list({ namespaces: readable(ctx), limit, offset, includeArchived, archivedOnly, ...wf });

  return { store, token, opts, tokens, annotRead, authFailures, tarpit, perToken, taintedReadsFor, dashboardSessions, anon, serverNs, readable, trustedHint, denyUnreadable, denyUnwritable, listReadable };
}

export type ApiCtx = ReturnType<typeof apiContext>;

/** What handle() knows about one request once it is authenticated and allowed; every route file gets it. */
export interface ApiReq {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  ip: string;
  anonLimited: () => boolean;
  principal: TokenEntry;
  scope: Scope;
  actorRef: ActorRef | undefined;
  need: Scope;
  nsCtx: NsCtx;
  isAdmin: boolean;
  pinnedWithGrants: () => boolean;
  refuseDistrustedOptIn: (nsHint?: string | null, byId?: boolean) => boolean;
  byIdRead: boolean;
  setReadQuery: (q: unknown) => void;
}
