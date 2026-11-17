#!/usr/bin/env node
// MCP server over stdio, for local Claude Code / Claude Desktop config.
// Also the `monomem-mcp` bin: a launcher that cannot pass arguments (e.g. a catalog entry that runs one bare command) gets
// the stdio server directly, since `monomem` with no arguments starts the HTTP server and dashboard instead.
// Points at the same SQLite file the HTTP API uses (MONOMEM_DB_PATH
// or the default <data dir>/state.db, see config.ts) so state written here is immediately
// visible to the API and vice versa.
import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import "./legacy-env.js"; // second: read the old CLAUDE_BRIDGE_* variables as MONOMEM_*
import { fileURLToPath } from "node:url";
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
setImmediate(() => store.warmBodyIndex()); // C-06: build the encrypted-body search index now, not on the first agent search
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
// The connection's folder is read per call, so adopting the client's workspace root (below) applies to later writes.
const conn: { local: true; cwd: string; maxSensitivity?: NonNullable<typeof stdioMax> } = stdioMax ? { maxSensitivity: stdioMax, local: true, cwd: process.cwd() } : { local: true, cwd: process.cwd() };
const server = createMcpServer(store, "admin", nsOpts ?? undefined, conn);
const transport = new StdioServerTransport();
/** How long to wait for the app to say which folder it has open (MCP roots) before keeping the launch folder. */
const ROOTS_WAIT_MS = 30_000;
// The client's own name from the initialize handshake goes to the audit log, labelled as a claim: any program can
// send any clientInfo. It is never used for written_by or for any access decision.
server.server.oninitialized = (): void => {
  const c = server.server.getClientVersion();
  audit({ op: "mcp.connect", label: stdio.writer, kind: "connection", detail: `claimed clientInfo: ${printable(c?.name, 60)} ${printable(c?.version, 30)}` });
  // C18: an app that launches this server outside the project (Cursor's global config, Claude Desktop, Codex) can still say
  // which workspace it has open (MCP roots). A single file:// root becomes the folder later writes record (notes.writer_cwd),
  // so session start can rank this project's notes first. No roots, an error or a slow answer: the launch folder stays.
  // Trust: this folder also matches hook-session taint (live and late, retroTaint) and the echo guard. Like the launch folder
  // it is the app's own claim (the app is the party that chose the launch folder too; an agent cannot set either). With
  // SEVERAL roots the agent may work in any of them, so picking one could miss a tainted session in another: the launch
  // folder stays (a home or app folder matches every session or none; none = the worst case, every open window applies).
  // Adopting a root is audited, so a person can see the claim.
  if (!server.server.getClientCapabilities()?.roots) return;
  // Waiting costs nothing (writes before the answer keep the launch folder), so the wait is long: a 2 s limit lost the
  // project folder for the whole session on a busy machine (seen on a loaded CI runner, every write ~2 s).
  server.server
    .listRoots(undefined, { timeout: ROOTS_WAIT_MS })
    .then((r) => {
      const files = r.roots.filter((x) => x.uri.startsWith("file:"));
      if (files.length !== 1) return;
      conn.cwd = fileURLToPath(files[0].uri);
      audit({ op: "mcp.root", label: stdio.writer, kind: "connection", detail: `writer folder from the app's MCP root: ${printable(conn.cwd, 200)}` });
    })
    .catch(() => {});
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
