// History with a diff per version (`monomem history <id> --diff`, GET /notes/<id>/history?diff=1, dashboard "History").
// Each earlier version is shown as the change it went through: its text -> the text that replaced it (the next version, or
// the note as it is now). Reads only. The lines come from lineDiff, so note text is control-character safe and cut to width;
// the dashboard still escapes every line.
import type { Store } from "./store.js";
import { lineDiff } from "./line-diff.js";
import { noteHistory, type Caller, type HistoryView } from "./supersede.js";
import { safe } from "./supersede-text.js";

export interface HistoryDiffRow {
  version: number;
  written_by: string;
  saved_at: string;
  saved_by: string;
  reason: string;
  /** "- " removed, "+ " added, "  " context; [] when only metadata changed. */
  diff: string[];
}
export interface HistoryDiffView extends Omit<HistoryView, "versions"> {
  versions: HistoryDiffRow[];
}

const textOf = (title: string, body: string): string => `${title}\n${body}`;

/** noteHistory plus a diff against the text that replaced each version. */
export function historyWithDiffs(store: Store, caller: Caller, id: number, opts: { includeDistrusted?: boolean } = {}): HistoryDiffView {
  const h = noteHistory(store, caller, id, opts);
  // A current note whose writer is distrusted is not shown (unless asked for): then its first diff is left out, not made up.
  const cur = store.readVisible(id, { includeDistrusted: opts.includeDistrusted === true });
  let newer: string | null = cur ? textOf(cur.title, cur.body ?? "") : null;
  const versions: HistoryDiffRow[] = [];
  // versions are newest first, so each one is compared with the text that replaced it (the one just before it in the list).
  // ponytail: when a distrusted version is hidden, the next shown one diffs against the text that replaced it, not the hidden one.
  for (const v of h.versions) {
    const old = textOf(v.title, v.body);
    versions.push({ version: v.version, written_by: v.written_by || v.claimed_writer || "", saved_at: v.saved_at, saved_by: v.saved_by, reason: v.reason, diff: newer === null ? [] : lineDiff(old, newer) });
    newer = old;
  }
  return { note_id: h.note_id, current: h.current, hidden_by_trust_policy: h.hidden_by_trust_policy, versions };
}

/** The CLI text: one block per version, newest first. */
export function renderHistoryDiff(v: HistoryDiffView): string[] {
  const out = [`Note ${v.note_id}: now at version ${v.current.version}, written by "${safe(v.current.written_by, 40)}".`];
  if (!v.versions.length) out.push("No earlier versions are kept.");
  for (const r of v.versions) {
    out.push(`  version ${r.version} by "${safe(r.written_by, 40) || "unknown"}", replaced ${r.saved_at.slice(0, 16).replace("T", " ")} by "${safe(r.saved_by, 40)}" (${safe(r.reason, 40)}):`);
    out.push(...(r.diff.length ? r.diff.map((l) => `      ${l}`) : ["      (only details other than the text changed)"]));
  }
  if (v.hidden_by_trust_policy > 0) out.push(`${v.hidden_by_trust_policy} version(s) hidden: their writer is on the distrust list (--include-distrusted shows them).`);
  return out;
}

/** `monomem history <id> --diff [--json]`. */
export function historyDiffCli(store: Store, caller: Caller, id: number, includeDistrusted: boolean, json: boolean, out: (s: string) => void): number {
  const v = historyWithDiffs(store, caller, id, { includeDistrusted });
  if (json) out(JSON.stringify(v, null, 2));
  else renderHistoryDiff(v).forEach((l) => out(l));
  return 0;
}
