// Module-level helpers shared by the REST routes: scope rules, error and JSON replies, the read-log hook and the query
// parameter parsers. Moved out of api.ts unchanged.

import { ServerResponse } from "node:http";
import { Store, ValidationError, QuarantinedError, StaleWriteError, WriterPausedError, NoteUnreadableError } from "../store.js";
import { RECEIPT_CHECK, type WriteReceipt } from "../store/write-receipt.js";
import { LIMITS, printable } from "../security.js";
import { type Scope, PROJECT_ROOT } from "../config.js";
import { assetsRoot } from "../self.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SupersedeError } from "../supersede.js";
import { isBusyError } from "../restore.js";

// The phone command page (docs/sign.html + docs/signer.js) is served from the
// API's own origin so a phone browser can POST /notes without a cross-origin
// request. Read once and cached; missing files simply 404.
// Off by default: the runner ships separately from the memory package, so a
// plain memory install exposes nothing runner-related. Set
// MONOMEM_ENABLE_SIGN_PAGE=1 to serve it; otherwise both paths 404.
export const SIGN_PAGES: Record<string, { file: string; type: string }> = {
  "/sign": { file: "sign.html", type: "text/html; charset=utf-8" },
  "/signer.js": { file: "signer.js", type: "application/javascript; charset=utf-8" },
};
export const signCache = new Map<string, string | null>();
export function signAsset(file: string): string | null {
  if (process.env.MONOMEM_ENABLE_SIGN_PAGE !== "1") return null;
  if (!signCache.has(file)) {
    try {
      signCache.set(file, readFileSync(join(assetsRoot() ?? PROJECT_ROOT, "docs", file), "utf8"));
    } catch {
      signCache.set(file, null);
    }
  }
  return signCache.get(file) ?? null;
}

/**
 * Import size above which the similarity-graph rebuild is DEFERRED rather
 * than done inline. Linking is O(n^2) and dominates bulk-restore time
 * (measured 88-97%), while only affecting neighbor ranking -- not search,
 * not the stored notes. 200 is where inline linking starts to cost seconds;
 * below it the graph is ready immediately, which matters more for a 1-note
 * import than the saved milliseconds.
 */
export const IMPORT_EDGE_DEFER_THRESHOLD = 200;

// The quality and health scans read every note. The dashboard asks on every load, so answers are reused for a minute
// (and a second request that arrives while one is running shares it).
// MONOMEM_SCAN_CACHE_SECONDS changes the minute (0 = never reuse).
export const scanCache = new Map<string, { at: number; value: Promise<unknown> }>();
export function cachedFor<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  const ttl = Math.max(0, Number(process.env.MONOMEM_SCAN_CACHE_SECONDS ?? "60") || 0) * 1000;
  const k = `${(store as unknown as { __scanId?: number }).__scanId ??= ++scanIds}:${key}`;
  const hit = scanCache.get(k);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = fn();
  scanCache.set(k, { at: Date.now(), value });
  value.catch(() => scanCache.delete(k));
  if (scanCache.size > 50) scanCache.clear();
  return value;
}
export let scanIds = 0;

/** When each app (by label) last made a request, since the server started. Shown in the dashboard's Apps panel. */
/** How long a dashboard session (monomem open, at a terminal) keeps its read-rule exemption for confirms. */
export const DASHBOARD_SESSION_TTL_MS = 8 * 3_600_000;

export const lastUsed = new Map<string, string>();

// Minimum scope a request needs: deletes, imports and full /export are admin,
// creates/updates are write, everything else (read/search/list) is read.
export function requiredScope(method: string | undefined, path: string): Scope {
  if (method === "DELETE") return "admin";
  if (method === "POST" && path === "/import") return "admin";
  // The trust policy (distrusted writers, trusted attesters) is admin-only,
  // reads included: it names who an operator does not trust.
  if (path === "/trust" || path.startsWith("/trust/")) return "admin";
  // A full-store dump is admin-only; a read token can still page /notes.
  if (method === "GET" && path === "/export") return "admin";
  if (path === "/status") return "admin";
  // /relevant is a read despite the POST method (the message is a JSON body,
  // not a query string, because it can be long) -- same class as /search.
  if (method === "POST" && path === "/relevant") return "read";
  // POST /get (automatic memory: full notes by id) is a read too; POST /capture is a write (the default below).
  if (method === "POST" && path === "/get") return "read";
  // Acking a change-feed position moves only the caller's own consumer marker.
  if (method === "POST" && path === "/ack") return "read";
  // Approving a command task is the human gate in front of the runner.
  if (method === "POST" && /^\/tasks\/\d+\/approve$/.test(path)) return "admin";
  // The list of apps that may connect (and their ceilings) is admin-only, reads included.
  if (path === "/tokens" || path.startsWith("/tokens/")) return "admin";
  // /rebuild-edges rewrites the similarity graph: admin-only, like delete.
  if (method === "POST" && path === "/rebuild-edges") return "admin";
  // Retention: archiving hides a note from every read surface (a soft
  // delete) and the sweep archives many at once -- both admin, like DELETE.
  // Restoring is equally admin: it re-exposes a note an operator retired.
  if (method === "POST" && /^\/notes\/\d+\/(archive|restore)$/.test(path)) return "admin";
  if (method === "POST" && path === "/sweep-expired") return "admin";
  // The quality view lists titles from every writer, and approving a held write is the linter's human gate.
  if (path === "/audit" || path === "/insights") return "admin";
  if (path === "/quality" || path === "/quarantine" || /^\/quarantine\/\d+\/(approve|reject|keep-history|context)$/.test(path)) return "admin";
  // Approve-first is the switch in front of an agent's own writes: reading or flipping it is admin, like the queue itself.
  if (path === "/approve-first") return "admin";
  // Pins and rollback are operator switches, like approve-first.
  if (path === "/pinned" || path === "/rollback/preview" || path === "/rollback/confirm") return "admin";
  // The read access log shows every agent's queries, and the flood pause is the operator's switch: admin, reads included.
  if (path === "/access" || path === "/flood" || path === "/flood/resume") return "admin";
  // A note's earlier versions can hold text that was taken out on purpose: administrators only, reads included.
  if (/^\/notes\/\d+\/history(\/restore)?$/.test(path)) return "admin";
  // 1.4.0: any writer may confirm; who counts (and as what kind) is decided by Store.confirm, an admin token as `admin`.
  if (method === "POST" && /^\/notes\/\d+\/confirm$/.test(path)) return "write";
  if (method === "POST" || method === "PUT") return "write";
  return "read";
}

// Map a thrown error to an HTTP response: caller-input problems (ValidationError)
// return 400 with the message; anything unexpected logs server-side and returns
// a generic 500 so SQL/internal details never leak to the client.
// REST note bodies: a field Monomem does not know (a client sent `content` for `body`) used to be dropped, leaving an empty note.
// written_by / created_by are accepted and ignored: the server stamps the writer from the token.
export const POST_NOTE_FIELDS = ["namespace", "title", "body", "tags", "source", "created_at", "forget_after", "confidence", "facts", "written_by", "created_by", "sensitivity", "outside", "derived_from", "client_key", "files"];
export const PUT_NOTE_FIELDS = ["namespace", "title", "body", "tags", "source", "forget_after", "confidence", "if_rev", "facts", "written_by", "created_by", "sensitivity", "outside", "derived_from"];
// Fields of a note the server returns. A client that GETs a note and PUTs it back whole sends these; they are ignored (never applied).
// `rev` is ignored too: use `if_rev` for compare-and-swap.
export const PUT_READ_ONLY_FIELDS = [
  "id", "rev", "created_at", "updated_at", "written_by", "created_by", "writer_id", "imported_written_by", "imported_created_by",
  "imported_unverified", "attested_writer", "attested_by", "attested_writer_id", "merged_from_writers", "distrusted", "confidence_claimed_by",
  "status", "superseded_by", "superseded_at", "superseded_by_writer", "access_count", "last_accessed", "expires_at", "archived_at",
  "pinned", "session_id", "obs_type", "stale", "ageDays", "staleWarning", "unreadable", "encrypted", "neighbors", "history", "files", "score", "breakdown",
  "grandfathered_at", "approved_at", "approved_by", "confirmed_at", "confirmed_by", "confirmed_kind", "confirmed_rev", "unconfirmed", "unconfirmed_label", "expired", "expired_label", "built_on_distrusted", "built_on_distrusted_label", "disputed", "disputed_label", "flagged", "flagged_label", "code_changed", "code_changed_label", "restated_by", "restated_label", "echo_of", "echo_label",
];
/** A 400 message naming the unknown top-level fields of a note body, or null when there are none. */
export function unknownNoteFields(body: unknown, allowed: readonly string[], ignored: readonly string[] = []): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const bad = Object.keys(body).filter((k) => !allowed.includes(k) && !ignored.includes(k));
  return bad.length ? `unknown field${bad.length === 1 ? "" : "s"}: ${bad.map((k) => printable(k, 40)).join(", ")} (allowed: ${allowed.join(", ")})` : null;
}

/** `receipt` (R2-06): the audit line of a note write's held / refused decision, from Store.refusedWriteReceipt. */
export function sendError(res: ServerResponse, e: unknown, receipt?: WriteReceipt): void {
  const r = receipt ? { receipt, receipt_check: RECEIPT_CHECK } : {};
  // A linter-held write was accepted for admin review, not rejected: 202.
  if (e instanceof QuarantinedError) {
    sendJson(res, 202, {
      quarantined: {
        id: e.quarantineId,
        reasons: e.findings,
        next: "The write was held, not lost. An administrator can approve or reject it in the dashboard, or with: monomem review held list",
      },
      ...r,
    });
    return;
  }
  if (e instanceof SupersedeError) {
    sendJson(res, e.status, { error: e.message, ...(e.warning ? { warning: e.warning } : {}) });
  } else if (e instanceof StaleWriteError) {
    sendJson(res, 409, { error: e.message, ...r });
  } else if (e instanceof WriterPausedError) {
    sendJson(res, 429, { error: e.message, ...r });
  } else if (e instanceof ValidationError) {
    sendJson(res, 400, { error: e.message, ...r });
  } else if (e instanceof NoteUnreadableError) {
    console.error("[monomem] " + e.message);
    sendJson(res, 500, { error: e.message, id: e.noteId });
  } else if (isBusyError(e)) {
    // 1.5.0 (infra HIGH-1): another program held the database lock past the wait. Retryable, not a server fault.
    console.error("[monomem] write gave up waiting for the database lock:", (e as Error).message);
    res.setHeader("Retry-After", "2");
    sendJson(res, 503, { error: "The database is busy (another program is writing to it); nothing was saved. Try again in a few seconds." });
  } else {
    console.error("[monomem] write error:", (e as Error).message);
    sendJson(res, 500, { error: "internal error" });
  }
}

/**
 * REST routes that hand memory to the caller. Each 200 answer is one row in the read access log (Store.logAccess),
 * written by sendJson from the request's actor context. GET /export logs itself (it streams).
 */
export const READ_ROUTES: Array<[string, RegExp]> = [
  ["GET", /^\/(notes|search|index|timeline|sessions|changes|stats|tasks|handoffs|catch-up|quality|files\/timeline)$/],
  ["GET", /^\/(notes|tasks)\/\d+$/],
  ["GET", /^\/notes\/\d+\/history$/],
  ["GET", /^\/sessions\/[^/]+$/],
  ["POST", /^\/(relevant|get)$/],
];
export const isReadRoute = (method: string | undefined, path: string): boolean => READ_ROUTES.some(([m, re]) => m === method && re.test(path));
/** Per-response read logger, set by handle() for a read route and run once by sendJson. */
export const pendingReads = new WeakMap<ServerResponse, (payload: unknown) => void>();

/**
 * Every note in an API answer says which label it has. The store leaves the field out for the default ("internal") so that
 * records keep their old shape in code; an app reading the API should not have to know that, so it is filled in here.
 * (Full exports are left as they are: they are a backup format.)
 */
export function showLabels(v: unknown, depth = 0): void {
  if (!v || typeof v !== "object" || depth > 6) return;
  if (Array.isArray(v)) {
    for (const x of v) showLabels(x, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  if (typeof o.id === "number" && typeof o.title === "string" && typeof o.namespace === "string" && typeof o.rev === "number" && o.sensitivity === undefined) {
    o.sensitivity = "internal";
  }
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") showLabels(o[k], depth + 1);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  opts: { cap?: boolean } = {}
): void {
  // Never write twice / to an already-finished response (e.g. after a client
  // aborted an oversized upload). Guard before touching headers.
  if (res.writableEnded || res.headersSent) return;
  const logRead = pendingReads.get(res);
  if (logRead) {
    pendingReads.delete(res);
    if (status === 200) logRead(payload);
  }
  if (opts.cap !== false) showLabels(payload);
  let body = JSON.stringify(payload);
  // Cap response size so a huge store or broad query can't blow up an agent's
  // context window or the process memory. `/export` opts out (cap:false): it is
  // the explicit full-store backup path and must never be truncated.
  if (opts.cap !== false && Buffer.byteLength(body) > LIMITS.responseBytes) {
    status = 413;
    body = JSON.stringify({
      error: "response too large; narrow the query or use a smaller limit",
    });
  }
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // Note text must not sit in a browser or proxy cache, and a browser must not sniff a JSON body as HTML.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

/** Strict non-negative integer query param; absent = undefined. */
/** ?ack_mode=manual|auto (default auto). */
export function ackModeParam(url: URL): "auto" | "manual" | undefined {
  const v = url.searchParams.get("ack_mode");
  if (v === null || v === "") return undefined;
  if (v !== "auto" && v !== "manual") throw new ValidationError('ack_mode must be "auto" or "manual"');
  return v;
}

/**
 * `?written_by=` / `?not_written_by=` (the server-stamped last writer; a bare
 * label or a `<server_id>/<label>` writer id) and `?include_distrusted=1`
 * (show notes whose writer an admin distrusted, clearly marked).
 */
export type WriterFilter = { writtenBy?: string; notWrittenBy?: string; includeDistrusted?: boolean };
export function writerFilter(url: URL): WriterFilter {
  const is = url.searchParams.get("written_by");
  const not = url.searchParams.get("not_written_by");
  return {
    ...(is !== null && is !== "" ? { writtenBy: is } : {}),
    ...(not !== null && not !== "" ? { notWrittenBy: not } : {}),
    ...(flagParam(url, "include_distrusted") ? { includeDistrusted: true } : {}),
  };
}

/**
 * `?include_superseded=1` also lists notes a confirmed replacement retired (always labelled `status: "superseded"`);
 * `?superseded=1` lists only those. Both are read-scoped, like `includeArchived`: seeing that a note was replaced is not privileged.
 */
export type SupersededFilter = { includeSuperseded?: boolean; supersededOnly?: boolean };
export function supersededFilter(url: URL): SupersededFilter {
  return {
    ...(flagParam(url, "include_superseded") ? { includeSuperseded: true } : {}),
    ...(flagParam(url, "superseded") ? { supersededOnly: true } : {}),
  };
}

/** The change feed adds filters on the note's CURRENT writer (`note_written_by`). */
export function feedWriterFilter(url: URL): WriterFilter & { noteWrittenBy?: string; notNoteWrittenBy?: string } {
  const is = url.searchParams.get("note_written_by");
  const not = url.searchParams.get("not_note_written_by");
  return {
    ...writerFilter(url),
    ...(is !== null && is !== "" ? { noteWrittenBy: is } : {}),
    ...(not !== null && not !== "" ? { notNoteWrittenBy: not } : {}),
  };
}

export function flagParam(url: URL, name: string): boolean {
  return ["1", "true", "yes"].includes((url.searchParams.get(name) ?? "").toLowerCase());
}

/** Waiters are capped per namespace scope; a short stable key for it. */
export function waitScopeKey(namespaces: string[] | undefined): string {
  return namespaces ? [...namespaces].sort().join(",") : "*";
}

export function intParam(url: URL, name: string, min: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < min) {
    throw new ValidationError(`${name} must be an integer >= ${min}`);
  }
  return Number(raw);
}
