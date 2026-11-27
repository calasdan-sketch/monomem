// tools/call with a request that is not well formed, or arguments of the wrong type: one plain sentence, never a pile of
// validator output. A request with missing or invalid params is a JSON-RPC "invalid params" error (-32602); a tool called
// with a wrong-typed argument is a tool error that names the argument, the type it needs and the type it got.

import type { z } from "zod";
import { errorResult } from "./shared.js";
import type { McpCtx } from "./context.js";
import { guardInitialize } from "./rpc-errors.js";

const INVALID_PARAMS = -32602;

/** A JSON-RPC error with exactly this message (the SDK's own McpError would put "MCP error -32602:" in front of it). */
function invalidParams(message: string): Error {
  return Object.assign(new Error(message), { code: INVALID_PARAMS });
}

/** What a value is, in words a person would use. */
function typeWord(v: unknown): string {
  if (v === null) return "nothing (null)";
  if (Array.isArray(v)) return "a list";
  switch (typeof v) {
    case "string":
      return "text";
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    case "object":
      return "an object";
    default:
      return typeof v;
  }
}

const NEEDS: Record<string, string> = { string: "text", number: "a number", int: "a whole number", boolean: "true or false", array: "a list", object: "an object", record: "an object", null: "nothing (null)" };

function valueAt(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let v = root;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[k];
  }
  return v;
}

/** One sentence for a failed argument check: which argument, what it needs, what was sent. Nothing was done. */
export function plainArgError(tool: string, err: z.ZodError, args: unknown): string {
  const issue = err.issues[0];
  const field = issue.path.length ? issue.path.map(String).join(".") : "";
  const name = field ? `"${field}"` : "the arguments";
  const got = valueAt(args, issue.path);
  const code = issue.code as string;
  let sentence: string;
  if (code === "invalid_type") {
    const need = NEEDS[(issue as { expected?: string }).expected ?? ""] ?? String((issue as { expected?: string }).expected ?? "a different type");
    sentence = got === undefined ? `${name} is required and must be ${need}` : `${name} must be ${need}, but ${typeWord(got)} was sent`;
  } else if (code === "invalid_value" && Array.isArray((issue as { values?: unknown[] }).values)) {
    const choices = ((issue as { values: unknown[] }).values).map((x) => JSON.stringify(x)).join(", ");
    sentence = `${name} must be one of ${choices}${got === undefined ? "" : `, but ${typeof got === "string" ? JSON.stringify(got.slice(0, 40)) : typeWord(got)} was sent`}`;
  } else {
    sentence = `${name} is not valid (${String(issue.message).replace(/\s+/g, " ").slice(0, 160)})`;
  }
  const more = err.issues.length - 1;
  return `${tool}: ${sentence}${more > 0 ? ` (and ${more} more problem${more === 1 ? "" : "s"})` : ""}. Nothing was done.`;
}

type RawHandler = (req: unknown, extra: unknown) => Promise<unknown>;

/**
 * Wraps the SDK's tools/call handler. It sits in front of the SDK's own request parsing (which answered a missing `params`
 * with an internal error holding a raw validator dump), so the three request shapes a client can get wrong each get one
 * sentence, and a tool's arguments are checked here first so a wrong type names its argument.
 */
export function guardToolCalls(c: McpCtx): void {
  guardInitialize(c); // a malformed initialize is -32602 too
  const low = c.server.server as unknown as { _requestHandlers?: Map<string, RawHandler> };
  const inner = low._requestHandlers?.get("tools/call");
  if (!inner || !low._requestHandlers) return; // no tools registered here (nothing to guard)
  const tools = (c.server as unknown as { _registeredTools?: Record<string, { enabled?: boolean; inputSchema?: { safeParse?: (v: unknown) => { success: boolean; error?: z.ZodError } } }> })._registeredTools;
  low._requestHandlers.set("tools/call", async (req, extra) => {
    const params = (req as { params?: unknown } | null)?.params;
    if (params === undefined || params === null || typeof params !== "object" || Array.isArray(params)) {
      throw invalidParams('tools/call needs params with the tool name and its arguments, for example {"name": "memory_search", "arguments": {"query": "deploy"}}.');
    }
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string" || !name) throw invalidParams(`tools/call needs params.name, the name of the tool, as text; ${name === undefined ? "it is missing" : `${typeWord(name)} was sent`}.`);
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
      throw invalidParams(`params.arguments must be an object of named values, for example {"query": "deploy"}; ${typeWord(args)} was sent.`);
    }
    const tool = tools?.[name];
    if (tool && tool.enabled !== false && tool.inputSchema?.safeParse) {
      try {
        const parsed = tool.inputSchema.safeParse(args ?? {});
        if (!parsed.success && parsed.error) return errorResult(plainArgError(name, parsed.error, args ?? {}));
      } catch {
        /* a schema that cannot be run twice (async): the SDK's own check below still applies */
      }
    }
    return inner(req, extra);
  });
}
