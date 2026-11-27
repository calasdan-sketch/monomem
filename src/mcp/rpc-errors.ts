// JSON-RPC errors for the two requests a client can get wrong before any tool runs: an `initialize` whose protocolVersion is
// not text (the SDK answered -32603 with a raw validator dump), and an HTTP body that is not JSON (a bare 400 instead of -32700).

import type { McpCtx } from "./context.js";

export const INVALID_PARAMS = -32602;
export const PARSE_ERROR = -32700;

/** The body of an HTTP 400 for text that is not JSON: a JSON-RPC parse error, id null (the id is unknowable). */
export function parseErrorBody(): { jsonrpc: "2.0"; id: null; error: { code: number; message: string } } {
  return { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error: the request body is not valid JSON." } };
}

/** Why an initialize request is malformed, or null. Only the type of protocolVersion is checked; the SDK negotiates the value. */
export function initializeProblem(params: unknown): string | null {
  if (params === undefined || params === null || typeof params !== "object" || Array.isArray(params)) {
    return 'initialize needs params with protocolVersion, capabilities and clientInfo, for example {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "app", "version": "1"}}.';
  }
  const v = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof v === "string" ? null : `initialize needs params.protocolVersion as text, for example "2025-06-18"; ${v === undefined ? "it is missing" : "a different type was sent"}.`;
}

type RawHandler = (req: unknown, extra: unknown) => Promise<unknown>;

/** Wraps the SDK's initialize handler so a malformed request is -32602 with one sentence. */
export function guardInitialize(c: McpCtx): void {
  const low = c.server.server as unknown as { _requestHandlers?: Map<string, RawHandler> };
  const inner = low._requestHandlers?.get("initialize");
  if (!inner || !low._requestHandlers) return;
  // Not `async`: the extra promise tick let a pipelined client's next answers overtake the initialize answer on stdout.
  low._requestHandlers.set("initialize", (req, extra) => {
    const why = initializeProblem((req as { params?: unknown } | null)?.params);
    return why ? Promise.reject(Object.assign(new Error(why), { code: INVALID_PARAMS })) : inner(req, extra);
  });
}
