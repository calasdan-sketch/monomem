// Transport-agnostic MCP server: registers the state tools (state_write,
// state_read, state_search, state_relevant, state_list, state_delete), the access-tracking
// memory_stats tool, the consolidation tools
// (memory_consolidation_candidates, memory_consolidate), and the similarity-graph
// memory_rebuild_edges tool, the memory_since change feed and the
// memory_quarantine review queue, directly against the shared Store. Both the stdio entry point and the
// HTTP/SSE entry point build one of these per connection/process, always
// pointed at the same SQLite file as the HTTP API -- there is exactly one
// state store, not a mock or a second copy.
//
// The tools live in src/mcp/tools-*.ts, the per-connection state they share in src/mcp/context.ts, and the default tool
// list in src/mcp/tool-names.ts. This file wires them together in a fixed order (the tools/list order).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Store } from "./store.js";
import { type Scope, PACKAGE_VERSION } from "./config.js";
import type { ServerNamespaceOpts } from "./namespace.js";
import { mcpContext } from "./mcp/context.js";
import type { ConnectionCtx } from "./mcp/shared.js";
import { registerNotesWriteTools } from "./mcp/tools-notes-write.js";
import { registerNotesReadTools } from "./mcp/tools-notes-read.js";
import { registerAdminTools } from "./mcp/tools-admin.js";
import { registerTaskTools } from "./mcp/tools-tasks.js";
import { registerTrustTools } from "./mcp/tools-trust.js";
import { registerSupersedeTools } from "./mcp/tools-supersede.js";
import { registerSessionTools } from "./mcp/tools-sessions.js";
export { PACKAGE_VERSION };
export { LIST_BODY_CHARS, OPERATOR_ONLY_TOOLS, type ConnectionCtx } from "./mcp/shared.js";
export { DEFAULT_TOOLS, enabledToolNames } from "./mcp/tool-names.js";

/** The stdio server's hourly housekeeping (most installs never run the HTTP server, which does the same): expiry and change-log pruning. Never throws. */
export function stdioSweep(store: Store, log: (msg: string) => void = (m) => process.stderr.write(m + "\n")): void {
  try {
    store.sweepExpired();
  } catch (e) {
    log(`[monomem] expiry sweep failed: ${(e as Error).message}`);
  }
  try {
    store.purgeChangeLog();
  } catch (e) {
    log(`[monomem] change-log purge failed: ${(e as Error).message}`);
  }
}

/**
 * Build the MCP server. `scope` is the caller's access level (from their
 * token on the HTTP transport); it defaults to "admin" for the local stdio
 * transport, which has no token and is trusted as the machine owner.
 *
 * `opts.namespace` activates server-side namespace resolution (see
 * src/namespace.ts): the model-supplied `namespace` parameter becomes an
 * untrusted hint. Writes always land in the resolved namespace, reads are
 * limited to the resolved namespace plus its `readsFrom` grants. When
 * `opts.namespace` is unset, behavior is exactly the legacy one --
 * model-supplied namespaces are honored.
 */
export function createMcpServer(
  store: Store,
  scope: Scope = "admin",
  opts: ServerNamespaceOpts = {},
  conn: ConnectionCtx = {}
): McpServer {
  const c = mcpContext(store, scope, opts, conn);
  registerNotesWriteTools(c);
  registerNotesReadTools(c);
  registerAdminTools(c);
  registerTaskTools(c);
  registerTrustTools(c);
  registerSupersedeTools(c);
  registerSessionTools(c);
  return c.server;
}
