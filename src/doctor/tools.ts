// doctor: the tool names, descriptions and inputs this build serves match the record `monomem tools --verify` made.
// Read-only: it never records anything itself (a check that records would hide the change it exists to show).
import type { Doctor } from "./report.js";

export async function toolPinCheck(dr: Doctor): Promise<void> {
  const { ok, warn } = dr;
  try {
    const { DATA_DIR, PACKAGE_VERSION } = await import("../config.js");
    const { pinPath, readPin, hashTools, servedTools, comparePin, pinWentMissing } = await import("../tool-pin.js");
    const { existsSync } = await import("node:fs");
    const path = pinPath(DATA_DIR);
    const stored = readPin(path);
    if (!stored && pinWentMissing(path)) {
      warn(
        "Tool descriptions: they were recorded once, but the record (tool-pin.json) is gone. A missing record cannot show whether the tool descriptions changed, so treat the current ones as unchecked.",
        "If you did not delete it, find out why. Then record the current tools again: monomem tools --verify --accept"
      );
      return;
    }
    if (!stored && existsSync(path)) {
      warn("Tool descriptions: the record (tool-pin.json) is there but cannot be read, so nothing was checked.", "monomem tools --verify --accept   (records the current tools again)");
      return;
    }
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
