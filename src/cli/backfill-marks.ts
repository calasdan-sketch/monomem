import { parseFlags } from "./shared.js";

// `monomem tidy marks [--yes]`: stamp ended sessions that read outside content before the stamp existed. Dry run unless --yes.
export async function backfillMarksCmd(): Promise<void> {
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  const { audit } = await import("../security.js");
  const { backfillOutsideMarks } = await import("../outside-backfill.js");
  const { flags } = parseFlags(process.argv.slice(3), { values: [], bools: ["yes", "dry-run"] });
  const store = new Store(DB_PATH);
  try {
    const apply = flags.yes === true && flags["dry-run"] !== true;
    const { found, applied } = backfillOutsideMarks(store, apply);
    if (!found.length) {
      console.log("Nothing to stamp: every ended session that read outside content already carries the mark.");
      return;
    }
    for (const r of found) console.log(`  session ${r.id.slice(0, 8)}: last outside read ${r.at}`);
    if (!apply) console.log(`DRY RUN: nothing was changed. ${found.length} ended session(s) would be stamped. Open sessions are never touched. Run \`monomem tidy marks --yes\` to apply (a backup first: \`monomem backup\`).`);
    else {
      audit({ op: "tidy.marks", label: "cli", kind: "session", detail: `stamped ${applied} ended session(s) with an outside-read mark` });
      console.log(`Stamped ${applied} ended session(s).`);
    }
  } finally {
    store.close();
  }
}
