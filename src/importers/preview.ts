// The summary `import --auto` (and every dry run) prints below the counts: what was left out, sample titles, and what the
// memory linter may hold. Kept apart from foreign-import.ts.
import { printable } from "../security.js";
import type { RivalStats } from "./rivals.js";

const SAMPLE = 8;

interface Previewable {
  title: string;
  flags: string[];
}

/** `show` false prints only the left-out counts (a plain write run); true adds the samples and the trust explanation. */
export function previewSample(io: { out: (l: string) => void }, todo: Previewable[], stats: RivalStats, show: boolean): void {
  if (stats.skipped) io.out(`  ${stats.skipped} deleted, superseded, expired or older-version item(s) were left out.`);
  if (stats.duplicates) io.out(`  ${stats.duplicates} duplicate(s) (same id, or same title and text) skipped inside the file.`);
  if (!show) return;
  io.out(`\nSample titles (first ${Math.min(SAMPLE, todo.length)} of ${todo.length} new note(s)):`);
  for (const c of todo.slice(0, SAMPLE)) io.out(`  ${printable(c.title, 70)}`);
  io.out(
    "\nTrust: every new note is saved unconfirmed (from outside), written by `import:<tool>`. The writer name the other tool gave is kept only as a\n" +
      "`claimed-writer:` tag, a claim and not an identity. Nothing is confirmed or trusted until a person runs `monomem confirm <id>`."
  );
  const flagged = todo.filter((c) => c.flags.length);
  if (flagged.length) {
    io.out(`${flagged.length} new note(s) would probably be held by the memory linter for your review:`);
    for (const c of flagged.slice(0, SAMPLE)) io.out(`  ${printable(c.title, 40)}: ${printable(c.flags.join(", "))}`);
  }
}
