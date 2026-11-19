// How often a captured session read outside content (the web, another MCP server). Counted from the stored tool events with the
// same rule that sets the session mark (isOutsideTool), NOT from the mark itself, so sessions captured before the mark existed
// are counted too. Read-only: it changes no mark and no setting. Honest about its limits: it is a rate over sessions that have
// captured events, shown with a 95% interval, and local file reads and shell fetches are not counted (taint.ts says why).
import type { Store } from "./store.js";
import { isOutsideTool } from "./taint.js";

export interface OutsideRate {
  sessions: number; // captured sessions that ran at least one tool (a session with only prompts and stops has no tool result to mark)
  allSessions: number; // every captured session, including those with no tool events
  outside: number; // of those, sessions with an outside-tool result
  since: string | null; // when the oldest counted event was captured
  low: number; // 95% interval, percent
  high: number;
}

/** Wilson score interval for k of n, in percent (stays inside 0-100 and is honest for small n). */
export function wilson(k: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const m = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Math.max(0, 100 * (m - h)), high: Math.min(100, 100 * (m + h)) };
}

export function outsideRate(store: Store, sinceIso?: string): OutsideRate | null {
  const db = store.captureDb();
  const rows = db
    .prepare("SELECT session_id, tool, event, (output != '' OR output_enc IS NOT NULL) AS has_output, at FROM capture_events WHERE tool != '' AND at >= ?")
    .all(sinceIso ?? "") as Array<{ session_id: string; tool: string; event: string; has_output: number; at: string }>;
  if (!rows.length) return null;
  const all = new Set<string>();
  const every = (db.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM capture_events WHERE at >= ?").get(sinceIso ?? "") as { n: number }).n;
  const hit = new Set<string>();
  let first = rows[0].at;
  for (const r of rows) {
    all.add(r.session_id);
    if (r.at < first) first = r.at;
    // the live rule also needs a non-empty output: a stored row has it plain or sealed (output_enc)
    if ((r.event === "post-tool" || r.event === "post-tool-failure") && r.has_output && isOutsideTool(r.tool)) hit.add(r.session_id);
  }
  const { low, high } = wilson(hit.size, all.size);
  return { sessions: all.size, allSessions: every, outside: hit.size, since: first, low, high };
}

export function renderOutsideRate(r: OutsideRate | null): string {
  if (!r) return "Outside reads: no captured session has run a tool yet, so there is nothing to count.";
  const pct = (100 * r.outside) / r.sessions;
  const pctAll = r.allSessions > 0 ? (100 * r.outside) / r.allSessions : 0;
  const thin = r.sessions < 30 ? " Too few sessions for a steady rate." : "";
  return (
    `Outside reads since ${(r.since ?? "").slice(0, 10)}: ${r.outside} of ${r.sessions} sessions that ran tools read the web or another MCP server ` +
    `(${pct.toFixed(0)}%, 95% range ${r.low.toFixed(0)}-${r.high.toFixed(0)}%); that is ${pctAll.toFixed(1)}% of all ${r.allSessions} captured sessions. ` +
    `Sessions that ran tools tend to be long, so the first figure is per working session, not per chat.${thin} ` +
    "Local file reads and shell fetches are not counted."
  );
}
