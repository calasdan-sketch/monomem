// doctor: after an upgrade, say ONCE that the stored notes were last checked by an older memory linter and `monomem check --rescan`
// would check them with this version's. "Once": the version it was said for is written to lint-scan.json, so the next doctor run is quiet.
import type { Doctor } from "./report.js";

export async function rescanCheck(dr: Doctor): Promise<void> {
  try {
    const { DATA_DIR, DB_PATH, PACKAGE_VERSION } = await import("../config.js");
    const { existsSync } = await import("node:fs");
    if (dr.dbProblem || dr.oldSchema || !existsSync(DB_PATH)) return; // doctor never opens (and so never upgrades) a store that needs migrating
    const { readScanMarker, writeScanMarker } = await import("../rescan.js");
    const m = readScanMarker(DATA_DIR);
    if (m?.scanned_version === PACKAGE_VERSION || m?.suggested_version === PACKAGE_VERSION) return;
    const { Store } = await import("../store.js");
    const store = new Store(DB_PATH);
    let notes = 0;
    try {
      notes = store.countAll();
    } finally {
      store.close();
    }
    if (notes === 0) return;
    dr.warn(
      `The ${notes} stored note${notes === 1 ? " was" : "s were"} last checked by ${m?.scanned_version ? `the memory linter of version ${m.scanned_version}` : "an older memory linter"}, and this is version ${PACKAGE_VERSION}. A newer rule may match a note stored earlier. (This is said once.)`,
      "monomem check --rescan   (checks every note again and holds the ones that now match; it never deletes; add --dry-run to only look)"
    );
    try {
      writeScanMarker(DATA_DIR, { scanned_version: m?.scanned_version ?? "", scanned_at: m?.scanned_at ?? "", suggested_version: PACKAGE_VERSION });
    } catch {
      /* a read-only data folder: it will be said again next time, which is harmless */
    }
  } catch {
    /* the notes could not be opened: the database check already says why */
  }
}
