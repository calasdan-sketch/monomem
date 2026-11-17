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
import { createApiServer } from "./api.js";
import { createMcpHttpServer } from "./mcp-http.js";
import { hardenTokensFile } from "./tokens-admin.js";
import { listenErrorMessage } from "./http-common.js";
import {
  DB_PATH,
  DATA_DIR,
  API_PORT,
  MCP_HTTP_PORT,
  BIND_HOST,
  resolveTokens, startTokenReload,
  assertSafeExposure,
  AUTO_CONSOLIDATE_INTERVAL_MS,
  prepareDataDir,
  TOKEN_FILE,
  isLoopback,
} from "./config.js";
import { autoConsolidateCooperative, AUTO_MERGE_SCORE } from "./consolidate.js";
import { resolveStartupNamespace } from "./namespace.js";
import { warnUnlabelledExposure } from "./sensitivity.js";
import { openStoreOrExit, SERVER_BUSY_TIMEOUT_MS } from "./db-problem.js";
import { abortAllWaiters } from "./change-wait.js";
import { pruneStaleHeartbeats } from "./liveness.js";
import { rotateLogIfNeeded } from "./security.js";
import { maybeDailyBackupAsync, autoBackupOn } from "./backup-schedule.js";
import { appendFileSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join, resolve } from "node:path";

/**
 * `start --log` (1.5.0, U-12): a server with no terminal (`monomem open`, `monomem service install`) keeps what it prints in
 * <data>/server.log, one timestamped line each, rotated like audit.log (MONOMEM_AUDIT_MAX_BYTES / MONOMEM_AUDIT_KEEP).
 * The server prints no note text and no key, only paths, ports and errors.
 */
function logToFile(path: string): void {
  const write = process.stderr.write.bind(process.stderr);
  let writes = 0;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    try {
      rotateLogIfNeeded(path, writes++);
      const lines = String(chunk).replace(/\n$/, "").split("\n");
      appendFileSync(path, lines.map((l) => `${new Date().toISOString()} ${l}\n`).join(""), { mode: 0o600 });
    } catch {
      /* a full disk must not stop the server */
    }
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
}

prepareDataDir();
if (process.argv.includes("--log")) logToFile(join(dirname(resolve(DB_PATH)), "server.log"));
assertSafeExposure();
hardenTokensFile(); // 1.5.0: plain-text keys in tokens.json become hashes on the first start
const tokens = resolveTokens();
const store = openStoreOrExit(DB_PATH, { busyTimeoutMs: SERVER_BUSY_TIMEOUT_MS });
warnUnlabelledExposure(store, tokens);
setImmediate(() => store.warmBodyIndex()); // C-06: build the encrypted-body search index now, not on the first agent search
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
// r2-improvement #5: one busy port does not take the other transport down. Each one that cannot listen says why and what
// to do; the process exits only when neither could start.
let transportsFailed = 0;
function transportFailed(server: Server, port: number, envVar: string, what: string): Server {
  return server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(listenErrorMessage(e, port, envVar, what));
    transportsFailed += 1;
    if (transportsFailed === 2) process.exit(1);
    console.error(`[monomem] started without ${what}: everything else is running. Fix the port and restart to get ${what} back.`);
    scheduleJanitor(false);
  });
}
function scheduleJanitor(up: boolean): void {
  if (up) transportsUp += 1;
  if (!(AUTO_CONSOLIDATE_INTERVAL_MS && AUTO_CONSOLIDATE_INTERVAL_MS > 0)) return;
  if (transportsUp + transportsFailed !== 2 || transportsUp === 0) return;
  void runAutoConsolidation();
  const timer = setInterval(() => {
    void runAutoConsolidation();
  }, AUTO_CONSOLIDATE_INTERVAL_MS);
  timer.unref(); // never keep the process alive on the scheduler's account
}

transportFailed(apiServer, API_PORT, "MONOMEM_PORT", "API + dashboard").listen(API_PORT, BIND_HOST, () => {
  console.error(`[monomem] API + dashboard on http://${BIND_HOST}:${API_PORT}`);
  if (!isLoopback(BIND_HOST)) {
    console.error(`[monomem] warning: listening on ${BIND_HOST}, not loopback, over plain HTTP (tokens and notes cross the network unencrypted). Put it behind your own TLS / authenticated tunnel: see INFRA.md.`);
  }
  console.error(`[monomem] DB: ${DB_PATH}`);
  const tokenFromEnv = Boolean(process.env.MONOMEM_TOKEN && process.env.MONOMEM_TOKEN.trim());
  console.error(`[monomem] token: ${tokenFromEnv ? "from MONOMEM_TOKEN" : TOKEN_FILE}`);
  console.error(`[monomem] Open the dashboard: http://127.0.0.1:${API_PORT}/  (key in ${tokenFromEnv ? "MONOMEM_TOKEN" : TOKEN_FILE}; or run: monomem open)`);
  const tokenExpr = tokenFromEnv ? "$MONOMEM_TOKEN" : `$(cat "${TOKEN_FILE}")`;
  console.error(
    `[monomem] try: curl -H "Authorization: Bearer ${tokenExpr}" "http://127.0.0.1:${API_PORT}/notes?limit=5"`
  );
  scheduleJanitor(true);
});

transportFailed(mcpServer, MCP_HTTP_PORT, "MONOMEM_MCP_PORT", "MCP over HTTP").listen(MCP_HTTP_PORT, BIND_HOST, () => {
  console.error(
    `[monomem] MCP over HTTP on http://${BIND_HOST}:${MCP_HTTP_PORT}/mcp (for apps that connect over HTTP with a key; see docs/give-an-app-limited-access.md)`
  );
  scheduleJanitor(true);
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

// Automatic daily backup (backup-schedule.ts): checked a minute after start, then hourly; at most one copy a day,
// 7 daily + 4 weekly kept in <data>/backups. The dashboard's Settings switch is read on every tick; MONOMEM_AUTO_BACKUP=off
// (read once, here) stops the timer and wins over the switch.
// The copy runs on a worker thread (backup-worker.ts), so serving does not pause for it; one at a time.
let backupRunning = false;
const backupNow = (): void => {
  if (backupRunning) return;
  backupRunning = true;
  void maybeDailyBackupAsync(DB_PATH, { dataDir: DATA_DIR })
    .then((r) => {
      if (!r) return;
      if (r.error) console.error(`[monomem] automatic backup failed: ${r.error} (monomem check shows it; monomem backup makes one by hand)`);
      else if (r.made) console.error(`[monomem] automatic backup made in ${r.dir}${r.removed.length ? ` (${r.removed.length} older removed)` : ""}`);
      if (r.keyWarning) console.error(`[monomem] ${r.keyWarning}`);
    })
    .catch((e: unknown) => console.error(`[monomem] automatic backup failed: ${(e as Error).message}`))
    .finally(() => {
      backupRunning = false;
    });
};
const backupTimer = autoBackupOn() ? setInterval(backupNow, 3_600_000) : undefined;
backupTimer?.unref();
if (backupTimer) setTimeout(backupNow, 60_000).unref();

// Notice apps installed later (app-detect.ts): two minutes after start, then hourly, at most one look a day. Read only;
// the result is the "Connect / Not this one / Repair" items in Needs you and Settings.
// ponytail: runs on the server's thread (a few dozen small file reads, no app started); move it to a worker if it shows up in timings.
const appCheckNow = (): void => {
  void Promise.all([import("./app-detect.js"), import("./setup.js"), import("./config.js")])
    .then(([d, s, c]) => d.maybeCheckApps(s.realEnv(c.PACKAGE_VERSION), DATA_DIR))
    .catch((e: Error) => console.error(`[monomem] app check failed: ${e.message}`));
};
const appCheckTimer = setInterval(appCheckNow, 3_600_000);
appCheckTimer.unref();
setTimeout(appCheckNow, 120_000).unref();

// Device sync on a timer: only after `monomem sync setup --auto on` (off by default; it talks to your git remote).
void Promise.all([import("./sync/device.js"), import("./self.js")])
  .then(([d, self]) => d.startSyncTimer(DATA_DIR, () => self.selfCommand([]), (l) => console.error(l)))
  .catch((e: Error) => console.error(`[monomem] device sync timer not started: ${e.message}`));

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  clearInterval(purgeTimer);
  clearInterval(backupTimer);
  clearInterval(appCheckTimer);
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
process.on("SIGHUP", shutdown); // the terminal it ran in was closed
