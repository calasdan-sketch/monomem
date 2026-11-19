// doctor: the tool names, descriptions and inputs this build serves match the record `monomem tools --verify` made.
// Read-only: it never records anything itself (a check that records would hide the change it exists to show).
import type { Doctor } from "./report.js";

export async function toolPinCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  try {
    const { DATA_DIR, PACKAGE_VERSION } = await import("../config.js");
    const { pinPath, readPin, hashTools, servedTools, comparePin } = await import("../tool-pin.js");
    const stored = readPin(pinPath(DATA_DIR));
    if (!stored) {
      ok("Tool descriptions: not recorded yet (run `monomem tools --verify` once to record them)");
      return;
    }
    const v = comparePin(stored, hashTools(await servedTools(), PACKAGE_VERSION));
    if (v.status === "unchanged") ok("Tool descriptions: unchanged since they were recorded");
    else warn(`Tool descriptions: ${v.message}`, v.status === "changed-same-version" ? "Reinstall Monomem from the official package if you did not change anything." : "monomem tools --verify --accept");
  } catch (e) {
    warn(`Tool descriptions: could not be checked (${(e as Error).message})`);
  }
}
