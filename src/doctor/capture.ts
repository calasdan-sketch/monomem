// doctor: automatic memory (capture spool and backlog), similarity-link failures, and the data folder's size.

import type { Doctor } from "./report.js";

/** doctor warns above these (docs/footprint.md). */
const DOCTOR_MAX_DATA_BYTES = 1e9;
const DOCTOR_MAX_BACKLOG = 10_000;

/** Capture status, the spool, link-build failures, and the data folder size (docs/footprint.md). */
export async function captureCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  const { DB_PATH } = await import("../config.js");
  const { printable } = await import("../security.js");
  // Automatic memory: when did a hook last record something, and is anything waiting in the spool?
  // Footprint: how big the data folder is, and is anything piling up (docs/footprint.md).
  try {
    const { Store } = await import("../store.js");
    const { lastCaptureAt, captureBacklog, spoolSize, captureSettings, SPOOL_MAX_BYTES } = await import("../capture.js");
    const { dirBytes, DIR_BYTES_BUDGET_MS } = await import("../uninstall.js");
    const { DATA_DIR } = await import("../config.js");
    const spool = spoolSize(DATA_DIR);
    const set = captureSettings(DATA_DIR);
    let last: string | null = null;
    let backlog = 0;
    let edgeFails: Array<{ namespace: string; at: string; error: string }> = [];
    if (!dr.dbProblem && !dr.oldSchema) {
      const s = new Store(DB_PATH);
      try {
        last = lastCaptureAt(s);
        backlog = captureBacklog(s);
        edgeFails = s.edgeBuildFailures();
      } finally {
        s.close();
      }
    }
    console.log(`  [info] capture: ${set.enabled ? "on" : "off (MONOMEM_CAPTURE / capture.json)"}; last event ${last ?? "never"}; spool ${spool} bytes; ${backlog} event(s) not yet distilled`);
    if (spool >= SPOOL_MAX_BYTES) warn(`the capture spool is full (${spool} bytes): new events are dropped until a hook can open the database`);
    else if (spool > 0) warn(`${spool} bytes of captured events are waiting in the spool; the next hook that can open the database stores them`);
    for (const f of edgeFails) {
      warn(`the background similarity-link build for namespace "${printable(f.namespace, 80)}" failed at ${f.at}: ${printable(f.error, 200)}; new notes there get no related-note links until it succeeds`, "monomem tidy edges");
    }
    if (backlog > DOCTOR_MAX_BACKLOG) {
      warn(`${backlog} captured events are waiting to be distilled (over ${DOCTOR_MAX_BACKLOG}); that happens when a session starts or ends, so a failing session hook is the likely cause`);
    }
    const size = dirBytes(DATA_DIR);
    const mb = (size.bytes / 1e6).toFixed(1);
    if (size.truncated) {
      warn(`data folder ${DATA_DIR} is at least ${mb} MB and still growing — the scan stopped after ${DIR_BYTES_BUDGET_MS}ms instead of hanging; something unrelated to monomem may be using this folder, see docs/footprint.md`);
    } else if (size.bytes > DOCTOR_MAX_DATA_BYTES) {
      warn(`data folder ${DATA_DIR} is ${mb} MB (over ${DOCTOR_MAX_DATA_BYTES / 1e9} GB); docs/footprint.md says what is in it and what is safe to remove`);
    } else {
      ok(`data folder ${DATA_DIR} is ${mb} MB`);
    }
  } catch (e) {
    warn("capture status unavailable: " + (e as Error).message);
  }
}
