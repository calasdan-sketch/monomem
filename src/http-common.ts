// Small helpers shared by the two HTTP front doors (the REST API and the
// MCP-over-HTTP server) so their request handling can't drift: one body-size
// cap, one body reader with one error type, and one token normalizer.

import type { IncomingMessage, Server } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { type TokenEntry } from "./config.js";

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
export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let data = "";
    let bytes = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
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
    if (e.code === "EADDRINUSE") {
      console.error(
        `[monomem] ${what} port ${port} is already in use -- is Monomem (or something else) already running? ` +
          `Stop it, or pick another port with ${envVar}=<port>.`
      );
    } else if (e.code === "EACCES") {
      console.error(`[monomem] no permission to listen on ${what} port ${port}; pick another with ${envVar}=<port>.`);
    } else {
      console.error(`[monomem] ${what} server failed to listen on port ${port}: ${e.message}`);
    }
    process.exit(1);
  });
}

/**
 * Explicit connection limits instead of Node's defaults, so a slow or greedy client cannot hold the server open.
 * All can be changed: MONOMEM_MAX_CONNECTIONS (default 512), MONOMEM_HEADERS_TIMEOUT_MS (default 20000: time to send the
 * request line and headers), MONOMEM_REQUEST_TIMEOUT_MS (default 300000: time to send the whole request, which has to
 * allow a large /import over a slow link), MONOMEM_KEEPALIVE_TIMEOUT_MS (default 5000).
 */
export function applyServerLimits<T extends Server>(server: T): T {
  const num = (name: string, def: number): number => {
    const v = Number(process.env[name]);
    return process.env[name] !== undefined && process.env[name]!.trim() !== "" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : def;
  };
  server.maxConnections = num("MONOMEM_MAX_CONNECTIONS", 512) || 512;
  server.headersTimeout = num("MONOMEM_HEADERS_TIMEOUT_MS", 20_000);
  server.requestTimeout = num("MONOMEM_REQUEST_TIMEOUT_MS", 300_000);
  server.keepAliveTimeout = num("MONOMEM_KEEPALIVE_TIMEOUT_MS", 5_000);
  return server;
}
