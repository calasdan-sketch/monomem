// doctor: pre-upgrade copies of the database next to it.

import type { Doctor } from "./report.js";

/** doctor warns above these (docs/footprint.md). */
export const PREMIGRATION_WARN_DAYS = 14;

/** Pre-upgrade copies: how big, how old, how to remove them. */
export async function preUpgradeCopiesCheck(dr: Doctor): Promise<void> {
  const { warn } = dr;
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  // Pre-upgrade copies (`<db>.pre-v*-backup`) hold the notes as they were before an upgrade, outside
  // retention, deletes and at-rest encryption. Say that they exist, how big and how old, and how to remove them.
  for (const b of Store.preMigrationBackups(DB_PATH)) {
    const mb = (b.bytes / 1e6).toFixed(1);
    if (/\.partial(-journal|-wal|-shm)?$/.test(b.path)) {
      warn(`unfinished pre-upgrade copy ${b.path} (${mb} MB, ${b.age_days} day(s) old): a copy that was interrupted. It is safe to delete (monomem backup --prune-premigration).`);
      continue;
    }
    // Two weeks is long enough to notice a bad upgrade; after that the copy is mostly old notes nobody meant to keep (1.5.0 U-17).
    if (b.age_days > PREMIGRATION_WARN_DAYS) {
      warn(
        `pre-upgrade copy ${b.path} (${mb} MB, ${b.age_days} days old) is more than ${PREMIGRATION_WARN_DAYS} days old. It still holds notes you may since have deleted or encrypted.`,
        "If the upgrade works for you, remove it: monomem backup --prune-premigration  (this removes every pre-upgrade copy next to the database)"
      );
      continue;
    }
    console.log(
      `  [info] pre-upgrade copy ${b.path} (${mb} MB, ${b.age_days} day(s) old). It still holds notes you may since have deleted or encrypted. ` +
        "Keep it until you have checked the upgrade, then remove it: monomem backup --prune-premigration"
    );
  }
}
