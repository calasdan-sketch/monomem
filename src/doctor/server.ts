// doctor: a server running on this machine is the same version as this CLI, and its body search index.

import type { Doctor } from "./report.js";

/** True when version `a` (x.y.z, a pre-release tag ignored) is below `b`. */
export function versionBelow(a: string, b: string): boolean {
  const n = (v: string): number[] => v.split("-")[0].split(".").map((x) => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** A running server's version (an older one keeps writing the old shape) and its body index. */
export async function serverCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  const { API_PORT } = await import("../config.js");
  // 1.5.0 (U-10): a server still running the build from before an upgrade keeps writing in the old shape. Ask it which it is.
  // MONOMEM_NO_SERVER_PROBE=1 skips it (the test suite sets it, so a test never talks to a real server on this machine).
  if (process.env.MONOMEM_NO_SERVER_PROBE !== "1") try {
    const { PACKAGE_VERSION } = await import("../config.js");
    const { SCHEMA_VERSION: BUILD } = await import("../store.js");
    const res = await fetch(`http://127.0.0.1:${API_PORT}/health`, { signal: AbortSignal.timeout(1000) });
    const h = (await res.json()) as { status?: unknown; version?: unknown; schema?: unknown };
    if (h?.status === "ok") {
      const v = typeof h.version === "string" ? h.version : null;
      const older = v === null || versionBelow(v, PACKAGE_VERSION) || (typeof h.schema === "number" && h.schema < BUILD);
      if (older) {
        warn(
          `the Monomem server on port ${API_PORT} (${v ? `${v}, schema v${h.schema}` : "1.4 or older"}) is older than this CLI (${PACKAGE_VERSION}, schema v${BUILD}): restart it.`,
          "Stop the server (or the app that started it) and start it again, so it runs this version."
        );
      } else {
        ok(`server on port ${API_PORT} runs ${v}${versionBelow(PACKAGE_VERSION, v!) ? ` (newer than this CLI ${PACKAGE_VERSION}: update the CLI)` : ""}`);
      }
      // C-06: on an encrypted store, the server's in-memory body index (only a server proven to be this store's gets the key).
      const { provenLocalServer } = await import("../local-server.js");
      const proven = dr.sealedNotes > 0 && dr.storeIdForProbe ? await provenLocalServer(API_PORT, dr.storeIdForProbe, AbortSignal.timeout(1000)) : null;
      if (proven) {
        const st = (await (await fetch(`${proven.base}/status`, { headers: { authorization: `Bearer ${proven.key}` }, signal: AbortSignal.timeout(1000) })).json()) as {
          body_index?: { state?: string; notes?: number; errors?: number; fallbacks?: number; lastFallback?: string | null };
        };
        const b = st.body_index;
        if (b) {
          const line = `server body search index: ${b.state} (${b.notes ?? 0} notes indexed, ${b.errors ?? 0} bodies unreadable, ${b.fallbacks ?? 0} searches on titles and tags only)`;
          if (b.state === "ready" && !b.errors && !b.fallbacks) ok(line);
          else
            warn(
              line + (b.lastFallback ? `; last: ${b.lastFallback}` : ""),
              b.errors ? "Unreadable bodies were sealed with another key: monomem encrypt status" : b.state === "off" ? "MONOMEM_BODY_INDEX=off is set for the server" : "Searches that fall back say so in their reply (body_search)"
            );
        }
      }
    }
  } catch {
    /* no server running here, or not a Monomem one: nothing to compare */
  }
}
