// One "Needs you" count: the things only a person can settle. Shown as the dashboard badge (tab, title, app icon) and
// served at GET /ui/needs-you; the session-start line and the bare command can call needsYou() for the same number.
//   held        writes held until a person approves or rejects them
//   unconfirmed notes from outside content that nobody confirmed (kept out of session start)
//   conflicts   facts two writers disagree on (fact tier only: the "possible" tier is a guess, not a question for you)
//   backup      the last backup failed
//   sync        the last device sync failed (sync-status.json; a sync that is only late shows in monomem check)
//   apps        an app installed later to connect, or a connection to repair (app-detect.ts, checked daily by the server)
// Counts only, never note text. Silent (count 0) when nothing waits.
import type { Store } from "../store.js";
import { findConflicts, groupConflicts } from "../conflicts.js";
import { readBackupStatus, readUiSettings } from "./settings.js";
import { appsNeedingYou } from "../app-detect.js";
import { DATA_DIR, DB_PATH } from "../config.js";
import { syncProblem } from "../sync/device.js";
import { dirname } from "node:path";
import { currentCeiling } from "../actor.js";

export type NeedKind = "held" | "unconfirmed" | "conflicts" | "backup" | "sync" | "apps";
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

/** Last fact-dispute count per store, with the change stamp it was counted at. */
const disputeCache = new WeakMap<Store, { key: string; count: number }>();

/**
 * Fact-tier disputes, grouped as the Review list shows them. The dashboard asks after nearly every click, so this reads
 * only the notes that carry a fact: tag (the fact tier looks at nothing else), never every note: on an encrypted store
 * reading every note decrypts every body (~0.3-0.9 s at 10k notes, on the server's one thread). The count is reused while
 * nothing in the database changed (the same stamp as the unconfirmed count: this connection's writes, another process's
 * commit, the caller's sensitivity ceiling).
 * ponytail: liveFactNotesIn keeps the newest 5000 fact-tagged notes; past that the badge can undercount the Review list.
 */
function factDisputes(store: Store, namespaces?: string[]): number {
  const t = (store.db.prepare("SELECT total_changes() AS t").get() as { t: number }).t - store.bookkeepingChanges;
  const dv = (store.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  const key = JSON.stringify([namespaces ?? null, t, dv, currentCeiling() ?? null]);
  const hit = disputeCache.get(store);
  if (hit?.key === key) return hit.count;
  const notes = store.liveFactNotesIn(undefined, { includeNeverShow: true });
  const count = groupConflicts(findConflicts(store, { notes, ...(namespaces ? { namespaces } : {}) }).filter((c) => c.tier === "fact")).length;
  disputeCache.set(store, { key, count });
  return count;
}
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * `conflicts: false` skips the fact-dispute count (it reads every fact-tagged note), for callers on a tight time budget such as a hook.
 * `dataDir` is where backup-status.json and sync-status.json live: the database's folder (tests pass their own).
 */
export function needsYou(store: Store, opts: { namespaces?: string[]; conflicts?: boolean; dataDir?: string } = {}): NeedsYou {
  const items: NeedItem[] = [];
  const held = store.listQuarantine({ ...(opts.namespaces ? { namespaces: opts.namespaces } : {}), limit: HELD_CAP }).length;
  if (held) items.push({ kind: "held", count: held, view: "held", text: `${held >= HELD_CAP ? `${HELD_CAP} or more writes are` : plural(held, "write is", "writes are")} held until you approve or reject ${held === 1 ? "it" : "them"}.` });
  const unconfirmed = store.unconfirmedCount(opts.namespaces);
  if (unconfirmed) items.push({ kind: "unconfirmed", count: unconfirmed, view: "review", text: `${plural(unconfirmed, "note", "notes")} from outside content ${unconfirmed === 1 ? "waits" : "wait"} for you to confirm ${unconfirmed === 1 ? "it" : "them"}.` });
  if (opts.conflicts !== false) {
    const disputed = factDisputes(store, opts.namespaces);
    if (disputed) items.push({ kind: "conflicts", count: disputed, view: "review", text: `${plural(disputed, "fact has", "facts have")} two different answers from different writers.` });
  }
  const b = readBackupStatus(opts.dataDir ?? dirname(DB_PATH)); // backup-status.json sits next to the database (backup-schedule.ts)
  if (b && !b.ok) items.push({ kind: "backup", count: 1, view: "settings", text: `The last backup failed (${b.at.slice(0, 16).replace("T", " ")}).` });
  const sync = syncProblem(opts.dataDir ?? DATA_DIR);
  if (sync?.kind === "failed") items.push({ kind: "sync", count: 1, view: "settings", text: `The last sync with your other computers failed (${sync.at.slice(0, 16).replace("T", " ")}). Run monomem sync to see why.` });
  const dir = opts.dataDir ?? DATA_DIR;
  const apps = appsNeedingYou(dir, readUiSettings(dir).declined_apps);
  const names = (a: { label: string }[]): string => (a.length > 2 ? `${a[0].label}, ${a[1].label} and ${a.length - 2} more` : a.map((x) => x.label).join(" and "));
  if (apps.new.length) items.push({ kind: "apps", count: apps.new.length, view: "settings", text: `${names(apps.new)} ${apps.new.length === 1 ? "was" : "were"} installed after Monomem was set up: connect ${apps.new.length === 1 ? "it" : "them"} in Settings, or choose Not this one.` });
  if (apps.repair.length) items.push({ kind: "apps", count: apps.repair.length, view: "settings", text: `The Monomem connection in ${names(apps.repair)} would not start: Repair ${apps.repair.length === 1 ? "it" : "them"} in Settings.` });
  return { count: items.reduce((n, i) => n + i.count, 0), items };
}

const SHORT: Record<NeedKind, [string, string]> = {
  held: ["held write", "held writes"],
  unconfirmed: ["unconfirmed note", "unconfirmed notes"],
  conflicts: ["disputed fact", "disputed facts"],
  backup: ["failed backup", "failed backups"],
  sync: ["failed sync", "failed syncs"],
  apps: ["app to connect or repair", "apps to connect or repair"],
};
/**
 * Session start's one line (recall.ts): counts only, never note text; "" when nothing waits. Skips the conflict scan
 * (a hook has a tight time budget), so it can be lower than the dashboard badge.
 */
export function needsYouLine(store: Store, opts: { namespaces?: string[]; dataDir?: string } = {}): string {
  const n = needsYou(store, { ...opts, conflicts: false });
  if (!n.count) return "";
  const parts = n.items.map((i) => plural(i.count, ...SHORT[i.kind]) + (i.kind === "unconfirmed" ? " (from outside content, not shown)" : ""));
  // One command: `monomem review` covers held writes and unconfirmed notes; anything else is settled in the dashboard.
  const cmd = n.items.every((i) => i.kind === "held" || i.kind === "unconfirmed") ? "monomem review" : "monomem open";
  return `Monomem: ${parts.join(", ")} ${n.count === 1 ? "waits" : "wait"} for the user: ${cmd}.`;
}
