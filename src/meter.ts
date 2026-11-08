// What Monomem costs you: aggregate numbers only, never prompt or note text.
//
// One row per agent session: tokens the SessionStart hook injected, the full text of the notes those stood in for
// ("saved"; each injection counts only its own notes, never the whole capture log), and tokens the optional local model used (llm.ts; 0 when it is
// off). Plus, read live: capture events recorded and the database size on disk. Tokens are estimates at ~4 characters
// a token. Writes are best-effort: a meter that cannot write never costs a session its context.
import type { Store } from "./store.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS meter_sessions (
  session_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT '',
  injections INTEGER NOT NULL DEFAULT 0,
  injected_tokens INTEGER NOT NULL DEFAULT 0,
  saved_tokens INTEGER NOT NULL DEFAULT 0,
  llm_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
)`;

export interface MeterTotals {
  sessions: number;
  injections: number;
  injected_tokens: number;
  saved_tokens: number;
  llm_tokens: number;
}

export interface MeterStats {
  totals: MeterTotals;
  /** Newest first, at most 20. */
  recent: Array<Omit<MeterTotals, "sessions"> & { session_id: string; namespace: string; updated_at: string }>;
  capture_events: number;
  db_bytes: number;
  note: string;
}

/** Add to one session's counters (fail-silent). */
export function meterAdd(store: Store, sessionId: string, namespace: string, add: { injected?: number; saved?: number; llm?: number }): void {
  if (!sessionId) return;
  const db = store.captureDb();
  // Session start must never wait behind another process's write lock for a meter row: fail fast, say so, keep going.
  const prev = Number((db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown> | undefined)?.timeout ?? 0);
  try {
    db.exec("PRAGMA busy_timeout = 0;");
    db.exec(SCHEMA);
    const inj = add.injected !== undefined ? 1 : 0;
    db.prepare(
      `INSERT INTO meter_sessions (session_id, namespace, injections, injected_tokens, saved_tokens, llm_tokens, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET injections = injections + excluded.injections, injected_tokens = injected_tokens + excluded.injected_tokens,
         saved_tokens = saved_tokens + excluded.saved_tokens, llm_tokens = llm_tokens + excluded.llm_tokens, updated_at = excluded.updated_at`
    ).run(sessionId, namespace, inj, Math.max(0, Math.round(add.injected ?? 0)), Math.max(0, Math.round(add.saved ?? 0)), Math.max(0, Math.round(add.llm ?? 0)), new Date().toISOString());
  } catch (e) {
    process.stderr.write(`monomem: meter not updated (${(e as Error).message})\n`);
  } finally {
    try {
      db.exec(`PRAGMA busy_timeout = ${prev};`);
    } catch {
      /* the connection is gone; nothing to restore */
    }
  }
}

/** Per-session and total numbers, optionally limited to some namespaces. */
export function meterStats(store: Store, namespaces?: string[]): MeterStats {
  const db = store.captureDb();
  const where = namespaces ? ` WHERE namespace IN (${namespaces.map(() => "?").join(",") || "NULL"})` : "";
  const args = namespaces ?? [];
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meter_sessions'").get();
  const zero: MeterTotals = { sessions: 0, injections: 0, injected_tokens: 0, saved_tokens: 0, llm_tokens: 0 };
  const totals = has
    ? (db
        .prepare(
          `SELECT COUNT(*) AS sessions, COALESCE(SUM(injections),0) AS injections, COALESCE(SUM(injected_tokens),0) AS injected_tokens,
           COALESCE(SUM(saved_tokens),0) AS saved_tokens, COALESCE(SUM(llm_tokens),0) AS llm_tokens FROM meter_sessions${where}`
        )
        .get(...args) as unknown as MeterTotals)
    : zero;
  const recent = has
    ? (db
        .prepare(`SELECT session_id, namespace, injections, injected_tokens, saved_tokens, llm_tokens, updated_at FROM meter_sessions${where} ORDER BY updated_at DESC LIMIT 20`)
        .all(...args) as unknown as MeterStats["recent"])
    : [];
  const ev = db
    .prepare(`SELECT COUNT(*) AS c FROM capture_events e JOIN sessions s ON s.id = e.session_id${namespaces ? where.replace("namespace", "s.namespace") : ""}`)
    .get(...args) as { c: number };
  const pages = db.prepare("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()").get() as { b: number };
  return {
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Number(v)])) as unknown as MeterTotals,
    recent: recent.map((r) => ({ ...r })),
    capture_events: Number(ev.c),
    db_bytes: Number(pages.b),
    note: "Estimates at ~4 characters a token. llm_tokens counts only the optional local model (0 when MONOMEM_LLM_URL is unset); Monomem makes no other model calls.",
  };
}

const plural = (n: number, one: string, many = one + "s"): string => `${n} ${n === 1 ? one : many}`;

/** One line for `monomem doctor`. "Injected" counts everything the hook added: note text plus index lines, legend and footer. */
export function meterLine(m: MeterStats): string {
  const t = m.totals;
  const standIn = t.saved_tokens > 0 ? `, standing in for ~${t.saved_tokens} tokens of full note text` : "";
  return (
    `footprint: ${plural(t.sessions, "session")}, ${plural(t.injections, "injection")} of ~${t.injected_tokens} tokens in total (notes plus headers and footer)${standIn}, ` +
    `${t.llm_tokens} local-model tokens, ${plural(m.capture_events, "capture event")}, database ${(m.db_bytes / 1048576).toFixed(1)} MB`
  );
}
