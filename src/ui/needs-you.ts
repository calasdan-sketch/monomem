// One "Needs you" count: the things only a person can settle. Shown as the dashboard badge (tab, title, app icon) and
// served at GET /ui/needs-you; the session-start line and the bare command can call needsYou() for the same number.
//   held        writes held until a person approves or rejects them
//   unconfirmed notes from outside content that nobody confirmed (kept out of session start)
//   conflicts   facts two writers disagree on (fact tier only: the "possible" tier is a guess, not a question for you)
//   backup      the last backup failed
// Counts only, never note text. Silent (count 0) when nothing waits.
import type { Store } from "../store.js";
import { findConflicts, groupConflicts } from "../conflicts.js";
import { readBackupStatus } from "./settings.js";
import { DB_PATH } from "../config.js";
import { dirname } from "node:path";

export type NeedKind = "held" | "unconfirmed" | "conflicts" | "backup";
export interface NeedItem {
  kind: NeedKind;
  count: number;
  /** One plain sentence. */
  text: string;
  /** Where the dashboard settles it. */
  view: "held" | "review" | "settings";
}
export interface NeedsYou {
  count: number;
  items: NeedItem[];
}

const HELD_CAP = 500;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * `conflicts: false` skips the conflict scan (it reads every note), for callers on a tight time budget such as a hook.
 * `dataDir` is where backup-status.json lives: the database's folder (tests pass their own).
 */
export function needsYou(store: Store, opts: { namespaces?: string[]; conflicts?: boolean; dataDir?: string } = {}): NeedsYou {
  const items: NeedItem[] = [];
  const held = store.listQuarantine({ ...(opts.namespaces ? { namespaces: opts.namespaces } : {}), limit: HELD_CAP }).length;
  if (held) items.push({ kind: "held", count: held, view: "held", text: `${held >= HELD_CAP ? `${HELD_CAP} or more writes are` : plural(held, "write is", "writes are")} held until you approve or reject ${held === 1 ? "it" : "them"}.` });
  const unconfirmed = store.unconfirmedCount(opts.namespaces);
  if (unconfirmed) items.push({ kind: "unconfirmed", count: unconfirmed, view: "review", text: `${plural(unconfirmed, "note", "notes")} from outside content ${unconfirmed === 1 ? "waits" : "wait"} for you to confirm ${unconfirmed === 1 ? "it" : "them"}.` });
  if (opts.conflicts !== false) {
    const groups = groupConflicts(findConflicts(store, opts.namespaces ? { namespaces: opts.namespaces } : {}).filter((c) => c.tier === "fact"));
    if (groups.length) items.push({ kind: "conflicts", count: groups.length, view: "review", text: `${plural(groups.length, "fact has", "facts have")} two different answers from different writers.` });
  }
  const b = readBackupStatus(opts.dataDir ?? dirname(DB_PATH)); // backup-status.json sits next to the database (backup-schedule.ts)
  if (b && !b.ok) items.push({ kind: "backup", count: 1, view: "settings", text: `The last backup failed (${b.at.slice(0, 16).replace("T", " ")}).` });
  return { count: items.reduce((n, i) => n + i.count, 0), items };
}

const SHORT: Record<NeedKind, [string, string]> = {
  held: ["held write", "held writes"],
  unconfirmed: ["unconfirmed note", "unconfirmed notes"],
  conflicts: ["disputed fact", "disputed facts"],
  backup: ["failed backup", "failed backups"],
};
/**
 * Session start's one line (recall.ts): counts only, never note text; "" when nothing waits. Skips the conflict scan
 * (a hook has a tight time budget), so it can be lower than the dashboard badge.
 */
export function needsYouLine(store: Store, opts: { namespaces?: string[]; dataDir?: string } = {}): string {
  const n = needsYou(store, { ...opts, conflicts: false });
  if (!n.count) return "";
  const parts = n.items.map((i) => plural(i.count, ...SHORT[i.kind]));
  return `Monomem: ${parts.join(", ")} ${n.count === 1 ? "waits" : "wait"} for the user (they settle ${n.count === 1 ? "it" : "them"} in the dashboard: monomem open).`;
}
