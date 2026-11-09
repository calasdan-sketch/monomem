// MCP server over stdio, for local Claude Code / Claude Desktop config.
// Points at the same SQLite file the HTTP API uses (MONOMEM_DB_PATH
// or the default <data dir>/state.db, see config.ts) so state written here is immediately
// visible to the API and vice versa.
import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import "./legacy-env.js"; // second: read the old CLAUDE_BRIDGE_* variables as MONOMEM_*
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.js";
import { createMcpServer, stdioSweep } from "./mcp-server-core.js";
import { DB_PATH, prepareDataDir } from "./config.js";
import { resolveStartupNamespace } from "./namespace.js";
import { setProcessWriter, stdioWriter } from "./actor.js";
import { audit, printable } from "./security.js";
import { parseSensitivity, SENSITIVITY_HELP } from "./sensitivity.js";

prepareDataDir();
// No token on stdio: writes are stamped with the marker "stdio", or "stdio:<app>" when the launch config sets
// MONOMEM_CLIENT (setup does, per app). The app name is self-declared by that config, not authenticated.
const stdio = stdioWriter();
if (stdio.warning) process.stderr.write(`[monomem] ${stdio.warning}\n`);
setProcessWriter(stdio.writer);
let store: Store;
try {
  store = new Store(DB_PATH);
} catch (e) {
  // A person reads this in an app's log: one plain line, not a stack trace.
  process.stderr.write(`[monomem] cannot open the database: ${((e as Error).message ?? String(e)).replace(/\s+/g, " ")}\n`);
  process.exit(1);
}
// Most people never run the HTTP server (which sweeps hourly), so expired notes are archived here too:
// at startup and then hourly, idempotent, and a failure never stops the MCP server. The change log is pruned here too.
const sweep = (): void => stdioSweep(store);
sweep();
setInterval(sweep, 3_600_000).unref();
// Server-side namespace resolution: resolved ONCE at startup from the
// process working directory. Null when unconfigured (legacy behavior).
const nsOpts = resolveStartupNamespace(process.cwd());
// local: admin with no token was never a deliberate grant, so operator-only tools stay off for the agent.
// Stdio has no token, so it has no token ceiling: whoever starts this process reads everything. MONOMEM_STDIO_MAX_SENSITIVITY
// (public / internal / private) caps it anyway for setups that must use stdio. An app that must be kept away from private
// notes should use the HTTP server with its own token instead (docs/give-an-app-limited-access.md).
const stdioCeiling = (process.env.MONOMEM_STDIO_MAX_SENSITIVITY ?? "").trim();
const stdioMax = stdioCeiling ? parseSensitivity(stdioCeiling) : undefined;
if (stdioCeiling && !stdioMax) {
  console.error(`[monomem] MONOMEM_STDIO_MAX_SENSITIVITY must be ${SENSITIVITY_HELP} (got ${JSON.stringify(stdioCeiling)}); not starting.`);
  process.exit(1);
}
const server = createMcpServer(store, "admin", nsOpts ?? undefined, stdioMax ? { maxSensitivity: stdioMax, local: true } : { local: true });
const transport = new StdioServerTransport();
// The client's own name from the initialize handshake goes to the audit log, labelled as a claim: any program can
// send any clientInfo. It is never used for written_by or for any access decision.
server.server.oninitialized = (): void => {
  const c = server.server.getClientVersion();
  audit({ op: "mcp.connect", label: stdio.writer, kind: "connection", detail: `claimed clientInfo: ${printable(c?.name, 60)} ${printable(c?.version, 30)}` });
};

await server.connect(transport);

// Blank / whitespace-only lines are keepalives, not messages: swallow them
// instead of answering -32700. (The SDK's line reader has no hook for this,
// so we wrap its readMessage and drop empty lines from the buffer first.)
{
  const rb = (transport as unknown as { _readBuffer?: { _buffer?: Buffer; readMessage: () => unknown } })._readBuffer;
  if (rb && typeof rb.readMessage === "function") {
    const orig = rb.readMessage.bind(rb);
    rb.readMessage = () => {
      for (;;) {
        const buf = rb._buffer;
        const nl = buf ? buf.indexOf(0x0a) : -1;
        if (!buf || nl === -1 || buf.toString("utf8", 0, nl).trim() !== "") break;
        rb._buffer = buf.subarray(nl + 1);
      }
      return orig();
    };
  }
}

// JSON-RPC requires an error reply to a request that cannot be parsed:
// -32700 for malformed JSON, -32600 for JSON that is not a valid message.
// The SDK only reports these to onerror (nothing goes back on stdout), so a
// client that sent `{bad` would wait forever. Chain after connect(), which
// installs its own handler.
const sdkOnError = transport.onerror;
transport.onerror = (err: Error) => {
  sdkOnError?.(err);
  const parseError = err instanceof SyntaxError;
  const invalid = err?.name === "ZodError";
  if (!parseError && !invalid) return;
  void transport
    .send({
      jsonrpc: "2.0",
      id: null,
      error: parseError
        ? { code: -32700, message: "Parse error: request is not valid JSON" }
        : { code: -32600, message: "Invalid Request: not a JSON-RPC 2.0 message" },
    } as unknown as Parameters<typeof transport.send>[0])
    .catch(() => {});
};

// eslint-disable-next-line no-console
console.error(`[monomem] MCP stdio server connected. DB: ${DB_PATH}`);
if (nsOpts) {
  // eslint-disable-next-line no-console
  console.error(`[monomem] namespace resolution ACTIVE: namespace="${nsOpts.namespace}"`);
}

// The app closing its end of the pipe is the normal way a stdio server ends: close the store then too (buffered read
// counts are written), not only on a signal. Runs once.
let closed = false;
function shutdown(): void {
  if (closed) return;
  closed = true;
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
