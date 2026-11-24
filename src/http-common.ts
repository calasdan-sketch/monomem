// Small helpers shared by the two HTTP front doors (the REST API and the
// MCP-over-HTTP server) so their request handling can't drift: one body-size
// cap, one body reader with one error type, and one token normalizer.

import type { IncomingMessage, Server } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { createHmac } from "node:crypto";
import { envNum as num, PACKAGE_VERSION, type TokenEntry } from "./config.js";
import { SCHEMA_VERSION } from "./store.js";

/** GET /health on both servers (no DB): liveness for anyone, and the build and schema only for a caller with a valid key, so
 * `monomem doctor` (which has the key) can tell a server still running the old version after an upgrade (1.5.0, U-10) while an
 * unauthenticated caller learns nothing about the build (expert round 1, 2026-11-18). */
export function healthBody(authenticated: boolean): { status: "ok"; version?: string; schema?: number } {
  return authenticated ? { status: "ok", version: PACKAGE_VERSION, schema: SCHEMA_VERSION } : { status: "ok" };
}

/**
 * 1.5.0: GET /proof's answer. The session-start hook sends the main key only to a server that proves it holds the same key
 * and has the same store open: an HMAC, keyed by the key's SHA-256 (what the server keeps), over a fresh nonce and the store
 * id. It reveals neither, and is accepted nowhere as a credential.
 */
export const serverProof = (keySha256Hex: string, nonce: string, storeId: string): string =>
  createHmac("sha256", keySha256Hex.toLowerCase()).update(`monomem-local-proof
${nonce}
${storeId}`).digest("hex");

// 1MB cap so a bad client can't OOM the process. Shared by both servers.
export const MAX_BODY_BYTES = 1_000_000;

// Thrown by readBody when a request body exceeds its cap, so each handler can
// answer 413 (payload too large) instead of a generic 500.
export class PayloadTooLargeError extends Error {}

/**
 * Body cap for POST /import, the backup-restore path.
 *
 * /export is explicitly exempt from the RESPONSE cap ("a backup must dump the
 * whole store"), but /import never got the symmetric exemption -- so a store
 * of only ~2000 notes produced a backup larger than the 1MB request cap and
 * could not be restored over HTTP at all (413). A backup you cannot restore
 * is not a backup, so restore gets a cap sized for months of notes.
 *
 * Still finite: an unbounded request body is a memory-exhaustion vector, and
 * /import is admin-scoped. Override with MONOMEM_IMPORT_MAX_BYTES.
 */
export const IMPORT_BODY_BYTES = (() => {
  const raw = process.env.MONOMEM_IMPORT_MAX_BYTES;
  const n = raw ? Number(raw) : NaN;
  // Default 64MB (an admin-only restore; raise it for a bigger backup); clamp to [1MB, 2GB] so a typo can't disable it entirely.
  if (!Number.isFinite(n)) return 64 * 1024 * 1024;
  return Math.min(Math.max(Math.floor(n), 1_000_000), 2_000_000_000);
})();

/**
 * Read a request body to a string, capped at `maxBytes` (default
 * MAX_BODY_BYTES). Uses StringDecoder so a multi-byte char (emoji / Greek /
 * CJK) split across TCP chunks is decoded correctly rather than corrupted.
 * On overflow it rejects with PayloadTooLargeError and stops buffering
 * (memory stays bounded); it does NOT destroy the socket, so the handler can
 * still deliver a 413 response rather than resetting the connection.
 */
export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES, idleMs = 0, totalMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let data = "";
    let bytes = 0;
    let over = false;
    // idleMs > 0: no byte for that long ends the read and the connection (a slow client before sign-in, see readPreAuthBody).
    let idle: NodeJS.Timeout | undefined;
    const arm = (): void => {
      if (idleMs <= 0) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        over = true;
        reject(new Error("request body timed out"));
        req.socket.destroy();
      }, idleMs);
    };
    arm();
    // totalMs > 0: the whole body must arrive within that time, however steadily the bytes drip in (a client that sends one byte
    // every few seconds never trips the idle timer; code review 2026-11-23, F8).
    const total = totalMs > 0 ? setTimeout(() => {
      over = true;
      reject(new Error("request body took too long"));
      req.socket.destroy();
    }, totalMs) : undefined;
    const clear = (): void => { clearTimeout(idle); clearTimeout(total); };
    req.on("end", clear);
    req.on("close", clear);
    req.on("data", (chunk: Buffer) => {
      arm();
      if (over) return; // past the cap: drain remaining chunks without buffering
      bytes += chunk.length;
      if (bytes > maxBytes) {
        over = true;
        reject(new PayloadTooLargeError("payload too large"));
        return;
      }
      data += decoder.write(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(data + decoder.end());
    });
    req.on("error", reject);
  });
}

/** Body cap for a request that has not signed in (POST /login): a sign-in code is 32 characters. */
export const PRE_AUTH_BODY_BYTES = 4096;

/**
 * readBody for a caller nobody has authenticated yet. Small cap; 10 s without a byte, or 15 s in all, ends the read and the connection
 * (MONOMEM_PREAUTH_BODY_TIMEOUT_MS sets the idle time, the total is 1.5 times it), so slow bodies cannot fill the connection limit (audit 2026-11-23: 600 of
 * them locked out a valid client). requestTimeout (300 s) still bounds authenticated uploads such as /import.
 */
export function readPreAuthBody(req: IncomingMessage, maxBytes = PRE_AUTH_BODY_BYTES): Promise<string> {
  const ms = Number(process.env.MONOMEM_PREAUTH_BODY_TIMEOUT_MS);
  const idle = Number.isFinite(ms) && ms > 0 ? ms : 10_000;
  return readBody(req, maxBytes, idle, Math.round(idle * 1.5)); // total deadline: 15 s by default
}

// Accept either the historical single admin token (a string) or a scoped list.
export function normalizeTokens(token: string | TokenEntry[]): TokenEntry[] {
  return typeof token === "string" ? [{ token, scope: "admin", label: "primary" }] : token;
}

/**
 * A listen error (port taken, no permission) is an operator problem, not a
 * crash: print what to do and exit 1 instead of an unhandled 'error' stack.
 */
export function exitOnListenError(server: Server, port: number, envVar: string, what: string): Server {
  return server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(listenErrorMessage(e, port, envVar, what));
    process.exit(1);
  });
}

/** What went wrong listening on `port`, and what to do about it. */
export function listenErrorMessage(e: NodeJS.ErrnoException, port: number, envVar: string, what: string): string {
  if (e.code === "EADDRINUSE") {
    return (
      `[monomem] ${what} port ${port} is already in use -- is Monomem (or something else) already running? ` +
      `Stop it, or pick another port with ${envVar}=<port>.`
    );
  }
  if (e.code === "EACCES") return `[monomem] no permission to listen on ${what} port ${port}; pick another with ${envVar}=<port>.`;
  return `[monomem] ${what} server failed to listen on port ${port}: ${e.message}`;
}

/**
 * Explicit connection limits instead of Node's defaults, so a slow or greedy client cannot hold the server open.
 * All can be changed: MONOMEM_MAX_CONNECTIONS (default 512), MONOMEM_HEADERS_TIMEOUT_MS (default 20000: time to send the
 * request line and headers), MONOMEM_REQUEST_TIMEOUT_MS (default 300000: time to send the whole request, which has to
 * allow a large /import over a slow link), MONOMEM_KEEPALIVE_TIMEOUT_MS (default 5000).
 */
export function applyServerLimits<T extends Server>(server: T): T {
  server.maxConnections = num("MONOMEM_MAX_CONNECTIONS", 512) || 512;
  server.headersTimeout = num("MONOMEM_HEADERS_TIMEOUT_MS", 20_000);
  server.requestTimeout = num("MONOMEM_REQUEST_TIMEOUT_MS", 300_000);
  server.keepAliveTimeout = num("MONOMEM_KEEPALIVE_TIMEOUT_MS", 5_000);
  return server;
}
