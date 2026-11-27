// CLI bodies for `monomem handoff --digest` and `monomem why <id> --readers`. Loaded on demand by round3.ts / why.ts.
import type { Store } from "../store.js";
import { buildHandoffDigest } from "../handoff-digest.js";
import { readersOf } from "../store/readers.js";
import { printable } from "../security.js";

/** `monomem handoff --digest [--since 24h] [--as <writer>] [--ns <namespace>] [--json]`: the owner's view; --as leaves one agent's own changes out. */
export function digestCmd(store: Store, flags: Record<string, string | boolean | undefined>, namespace: string | undefined): void {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const d = buildHandoffDigest(store, { since: str(flags.since), self: str(flags.as), namespaces: namespace ? [namespace] : undefined, includeHeld: true });
  console.log(flags.json ? JSON.stringify(d, null, 2) : d.text);
}

/** `monomem why <id> --readers [--json]`: which apps and agents read the note and when, against when it last changed. */
export function readersCmd(store: Store, note: { id: number; updated_at: string | number }, json: boolean): void {
  const id = note.id;
  const r = readersOf(store.captureDb(), id);
  const out = { id, last_changed_at: note.updated_at, ...r };
  if (json) return console.log(JSON.stringify(out, null, 2));
  console.log(`#${id} last changed ${note.updated_at}; ${r.total_reads} recorded read${r.total_reads === 1 ? "" : "s"} by ${r.readers.length} reader${r.readers.length === 1 ? "" : "s"}${r.truncated ? " (first " + r.readers.length + " shown)" : ""}`);
  for (const x of r.readers) console.log(`  ${printable(x.writer, 40)}: ${x.reads} read${x.reads === 1 ? "" : "s"}, first ${x.first_at}, last ${x.last_at}${x.last_at >= String(note.updated_at) ? " (saw the current version)" : " (last read BEFORE the latest change)"}; via ${x.tools.map((t) => printable(t, 30)).join(", ")}`);
  console.log("Only apps and agents are recorded (not the owner's own shell), and only inside the access-log window.");
}
