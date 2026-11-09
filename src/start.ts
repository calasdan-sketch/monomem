// Combined entry: boots BOTH transports in one process, sharing ONE Store.
//   - REST API + dashboard on API_PORT        (default 8790)
//   - MCP over HTTP (the tunnel target)        default 8791 on MCP_HTTP_PORT
//
// One Store means one SQLite connection (WAL + busy_timeout) does all the
// writing, so the two transports never race each other on the same file.
// This is what `monomem start` and `npm start` run, and what the
// Docker image launches -- so a self-hoster who tunnels port 8791 actually
// has an MCP endpoint there, not a dead port.

import "./quiet-sqlite.js"; // first: hide the node:sqlite ExperimentalWarning
import "./legacy-env.js"; // second: read the old CLAUDE_BRIDGE_* variables as MONOMEM_*
import { Store } from "./store.js";
import { createApiServer } from "./api.js";
import { createMcpHttpServer } from "./mcp-http.js";
import { exitOnListenError } from "./http-common.js";
import {
  DB_PATH,
  API_PORT,
  MCP_HTTP_PORT,
  BIND_HOST,
  resolveTokens, startTokenReload,
  assertSafeExposure,
  AUTO_CONSOLIDATE_INTERVAL_MS,
  prepareDataDir,
  TOKEN_FILE,
} from "./config.js";
import { autoConsolidateCooperative, AUTO_MERGE_SCORE } from "./consolidate.js";
import { resolveStartupNamespace } from "./namespace.js";
import { warnUnlabelledExposure } from "./sensitivity.js";
import { openStoreOrExit } from "./db-problem.js";
import { abortAllWaiters } from "./change-wait.js";
import { pruneStaleHeartbeats } from "./liveness.js";

prepareDataDir();
assertSafeExposure();
const tokens = resolveTokens();
const store = openStoreOrExit(DB_PATH);
warnUnlabelledExposure(store, tokens);
startTokenReload(tokens);

// Namespace resolution happens ONCE here, at startup, from the process cwd --
// both transports share it, so MCP and REST enforce the same boundaries.
const nsOpts = resolveStartupNamespace(process.cwd());
if (nsOpts) {
  // eslint-disable-next-line no-console
  console.error(`[monomem] namespace resolution ACTIVE: namespace="${nsOpts.namespace}"`);
}

/**
 * Background auto-consolidation (opt-in via MONOMEM_AUTO_CONSOLIDATE_INTERVAL).
 * Conservative by design: only exact-duplicate pairs (title AND body
 * identical) scoring >= 0.99 are merged automatically; weaker candidates
 * and token-collapse near-duplicates are LOGGED for human review
 * via memory_consolidation_candidates, never merged blindly. Never throws —
 * a background janitor must not take down the server. When namespace
 * resolution is active, the candidate pool is restricted to the server's
 * own namespace, so it can never merge/delete another namespace's notes.
 *
 * The candidate scan is cooperative (yields to the event loop), so a large
 * scan doesn't stall concurrent API/MCP traffic the way the old
 * synchronous scan did.
 */
async function runAutoConsolidation(): Promise<void> {
  try {
    const { candidateCount, merged, skipped } = await autoConsolidateCooperative(store, {
      // Blocker #4: the nsActive janitor only touches ownNs -- mirroring the
      // MCP memory_consolidate tool (reads-from grants never confer the
      // right to restructure another namespace's notes).
      ownNamespace: nsOpts ? nsOpts.namespace : undefined,
    });
    if (candidateCount > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `[monomem] auto-consolidate: ${candidateCount} duplicate candidate pair(s) ` +
          `>= 0.95 — review with memory_consolidation_candidates`
      );
    }
    for (const s of skipped) {
      // eslint-disable-next-line no-console
      console.error(
        `[monomem] auto-consolidate: skipped pair #${s.idA}/#${s.idB}: ${s.reason}`
      );
    }
    for (const m of merged) {
      // eslint-disable-next-line no-console
      console.error(
        `[monomem] auto-consolidate: merged #${m.idA}+#${m.idB} -> #${m.mergedId}`
      );
    }
    if (merged.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`[monomem] auto-consolidate: ${merged.length} merge(s) done`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[monomem] auto-consolidate failed: ${(e as Error).message}`);
  }
}

const apiServer = createApiServer(store, tokens, nsOpts ?? undefined);
const mcpServer = createMcpHttpServer(store, tokens, nsOpts ?? undefined);

// The first janitor pass used to run synchronously inline here -- a ~1-2s
// candidate scan of dead air before the servers started accepting traffic.
// Now it is deferred until BOTH transports are actually serving (each
// listen callback counts down), and the pass itself is cooperative, so
// startup latency is unaffected and a large scan never stalls serving.
let transportsUp = 0;
function scheduleJanitor(): void {
  if (!(AUTO_CONSOLIDATE_INTERVAL_MS && AUTO_CONSOLIDATE_INTERVAL_MS > 0)) return;
  if (++transportsUp !== 2) return;
  void runAutoConsolidation();
  const timer = setInterval(() => {
    void runAutoConsolidation();
  }, AUTO_CONSOLIDATE_INTERVAL_MS);
  timer.unref(); // never keep the process alive on the scheduler's account
}

exitOnListenError(apiServer, API_PORT, "MONOMEM_PORT", "API").listen(API_PORT, BIND_HOST, () => {
  console.error(`[monomem] API + dashboard on http://${BIND_HOST}:${API_PORT}`);
  console.error(`[monomem] DB: ${DB_PATH}`);
  const tokenFromEnv = Boolean(process.env.MONOMEM_TOKEN && process.env.MONOMEM_TOKEN.trim());
  console.error(`[monomem] token: ${tokenFromEnv ? "from MONOMEM_TOKEN" : TOKEN_FILE}`);
  console.error(`[monomem] Open the dashboard: http://127.0.0.1:${API_PORT}/  (key in ${tokenFromEnv ? "MONOMEM_TOKEN" : TOKEN_FILE}; or run: monomem open)`);
  const tokenExpr = tokenFromEnv ? "$MONOMEM_TOKEN" : `$(cat "${TOKEN_FILE}")`;
  console.error(
    `[monomem] try: curl -H "Authorization: Bearer ${tokenExpr}" "http://127.0.0.1:${API_PORT}/notes?limit=5"`
  );
  scheduleJanitor();
});

exitOnListenError(mcpServer, MCP_HTTP_PORT, "MONOMEM_MCP_PORT", "MCP").listen(MCP_HTTP_PORT, BIND_HOST, () => {
  console.error(
    `[monomem] MCP over HTTP on http://${BIND_HOST}:${MCP_HTTP_PORT}/mcp (for apps that connect over HTTP with a key; see docs/give-an-app-limited-access.md)`
  );
  scheduleJanitor();
});

if (AUTO_CONSOLIDATE_INTERVAL_MS && AUTO_CONSOLIDATE_INTERVAL_MS > 0) {
  console.error(
    `[monomem] auto-consolidation every ${AUTO_CONSOLIDATE_INTERVAL_MS}ms ` +
      `(auto-merge >= ${AUTO_MERGE_SCORE}; weaker candidates are only logged)`
  );
}

// The change log is pruned (90-day retention) on a timer, not only when
// someone happens to read the feed. Best-effort, unref'd, and cheap (one
// indexed DELETE): shortly after start, then hourly. (The interval can be
// shortened with MONOMEM_CHANGE_LOG_PURGE_MS; that is for tests.)
const purgeEveryMs = (() => {
  const n = Number(process.env.MONOMEM_CHANGE_LOG_PURGE_MS);
  return Number.isInteger(n) && n >= 100 ? n : 3_600_000;
})();
const purgeNow = (): void => {
  try {
    store.purgeChangeLog();
    pruneStaleHeartbeats(store);
    // TTLs used to need someone to call POST /sweep-expired; a note past its deadline stayed in search.
    store.sweepExpired();
  } catch (e) {
    console.error(`[monomem] change-log purge failed: ${(e as Error).message}`);
  }
};
const purgeTimer = setInterval(purgeNow, purgeEveryMs);
purgeTimer.unref();
setTimeout(purgeNow, Math.min(30_000, purgeEveryMs)).unref();

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  clearInterval(purgeTimer);
  // Live waits (memory_since / GET /changes?wait=) end NOW and answer with
  // timedOut:true, so a restart drains in milliseconds instead of resetting
  // sockets at the 3s safety net.
  abortAllWaiters();
  let pending = 2;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) {
      store.close();
      process.exit(0);
    }
  };
  apiServer.close(done);
  mcpServer.close(done);
  // Keep-alive connections would otherwise hold close() open: as the woken
  // waiters finish their responses their sockets go idle, so sweep idle
  // ones every 25ms until the servers are down.
  const sweep = setInterval(() => {
    apiServer.closeIdleConnections?.();
    mcpServer.closeIdleConnections?.();
  }, 25);
  sweep.unref();
  // Safety net: don't hang forever if a socket won't drain.
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
