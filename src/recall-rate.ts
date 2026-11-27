// "Recall rate": did agent sessions actually read memory? Counts only, no note text. Three honest numbers over one window:
//   started   sessions the capture hooks saw start (the `sessions` table; a session capture never saw is not counted)
//   shown     of those, sessions whose session start showed notes (memory_receipts has the session id)
//   read      of those, sessions during which an agent memory read was logged (access_log has NO session id, so this is matched by
//             time: a read inside a session's start..end counts for every session overlapping it)
// The window is cut to the access-log retention (MONOMEM_ACCESS_LOG_DAYS), because older reads and receipts are gone.
import type { Store } from "./store.js";
import { accessLogDays } from "./store.js";

export interface RecallRate {
  /** Days actually covered (the asked window, cut to the access-log retention). */
  window_days: number;
  retention_days: number;
  cut_by_retention: boolean;
  started: number;
  shown: number;
  read: number;
  /** Agent read calls in the window (every writer but the owner's shell and the session-start hooks). */
  read_calls: number;
  caveat: string;
}

const DAY = 86_400_000;
/** A session with no end time and no later event is given this long to count a read (an open session, or one that never closed). */
const OPEN_SESSION_MS = 6 * 3600_000; // ponytail: fixed guess for sessions that never recorded an end; recorded ends are used when present
export const RECALL_CAVEAT =
  "Sessions the capture hooks did not see are not counted. Reads are matched to sessions by time (the access log keeps no session id), so two sessions open at once share a read. A read means a memory tool call; whether the agent used the answer is not recorded.";

const hasTable = (store: Store, name: string): boolean => store.captureDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** First index in sorted `a` with a[i] >= x. */
function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function recallRate(store: Store, opts: { sinceIso: string; now?: number; namespaces?: string[] }): RecallRate {
  const now = opts.now ?? Date.now();
  const retention = accessLogDays();
  const asked = Date.parse(opts.sinceIso);
  const floor = retention > 0 ? now - retention * DAY : 0;
  const start = Math.max(Number.isFinite(asked) ? asked : floor, floor);
  const startIso = new Date(start).toISOString();
  const db = store.captureDb();
  const ns = opts.namespaces;
  const nsSql = ns ? ` AND namespace IN (${ns.map(() => "?").join(",")})` : "";
  const sessions = (ns && ns.length === 0 ? [] : db.prepare(`SELECT id, started_at, ended_at FROM sessions WHERE started_at >= ?${nsSql}`).all(startIso, ...(ns ?? []))) as Array<{ id: string; started_at: string; ended_at: string | null }>;
  const reads = (db.prepare("SELECT at FROM access_log WHERE at >= ? AND tool NOT LIKE 'hook:%' AND writer <> 'cli' ORDER BY at").all(startIso) as Array<{ at: string }>).map((r) => Date.parse(r.at)).filter(Number.isFinite);
  let shownIds = new Set<string>();
  if (sessions.length && hasTable(store, "memory_receipts")) {
    shownIds = new Set((db.prepare("SELECT DISTINCT session_id FROM memory_receipts WHERE at >= ?").all(startIso) as Array<{ session_id: string }>).map((r) => r.session_id));
  }
  let shown = 0;
  let read = 0;
  for (const s of sessions) {
    if (shownIds.has(s.id)) shown++;
    const from = Date.parse(s.started_at);
    const to = s.ended_at ? Date.parse(s.ended_at) : from + OPEN_SESSION_MS;
    const i = lowerBound(reads, from);
    if (i < reads.length && reads[i] <= to) read++;
  }
  return {
    window_days: Math.max(1, Math.round((now - start) / DAY)),
    retention_days: retention,
    cut_by_retention: Number.isFinite(asked) && asked < floor,
    started: sessions.length,
    shown,
    read,
    read_calls: reads.length,
    caveat: RECALL_CAVEAT,
  };
}

/** One honest line (two with `verbose`): the numbers with their denominators and the window. */
export function renderRecallRate(r: RecallRate, verbose = false): string {
  const win = `last ${r.window_days} day${r.window_days === 1 ? "" : "s"}${r.cut_by_retention ? ` (cut to the ${r.retention_days} days the access log keeps)` : ""}`;
  if (r.retention_days === 0) return `Recall (${win}): the read access log is off (MONOMEM_ACCESS_LOG_DAYS=0), so reads cannot be counted.`;
  if (r.started === 0) return `Recall (${win}): no sessions were captured, so there is no rate to give (monomem setup --capture records sessions).`;
  const line = `Recall (${win}): session start showed notes in ${r.shown} of ${r.started} captured sessions; an agent memory read was logged during ${r.read} of ${r.started}.`;
  return verbose ? `${line}\n  ${r.caveat}` : line;
}
