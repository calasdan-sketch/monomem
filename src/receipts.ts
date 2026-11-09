// Memory receipts: which notes a session start showed, and why. Ids, why-tags, rank and approximate tokens only --
// never note text or titles (same rule as the meter). Titles are looked up live from the store when a receipt is read.
// Kept as long as the read-access log (MONOMEM_ACCESS_LOG_DAYS, default 30; 0 = receipts off).
// Same pattern as meter.ts: CREATE TABLE IF NOT EXISTS in the capture database, so no schema version bump; writes are
// best-effort (a receipt that cannot be written never costs a session its context).
// Also here: the shareable savings card (`monomem meter --card`) and the CLI commands that use both.
import { localTimeOffset } from "./asof.js";
import { writeFileSync } from "node:fs";
import { accessLogDays, type Store } from "./store.js";
import { currentCeiling } from "./actor.js";
import { printable } from "./security.js";
import { meterStats, meterLine, type MeterTotals } from "./meter.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS memory_receipts (
  session_id TEXT NOT NULL,
  note_id INTEGER NOT NULL,
  namespace TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  rank INTEGER NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, note_id)
)`;

export interface ReceiptNote {
  id: number;
  rank: number;
  why: string;
  tokens: number;
  /** Looked up live: null when the note is gone or not visible to this reader. */
  title: string | null;
  /** ok = still readable; gone = deleted, archived or hidden by the trust policy since (not told apart: the gate hides the difference). */
  state: "ok" | "gone";
}
export interface ReceiptSummary {
  session_id: string;
  namespace: string;
  client: string;
  at: string;
  notes: number;
  tokens: number;
}
export interface Receipt extends Omit<ReceiptSummary, "notes"> {
  notes: ReceiptNote[];
}

/** Record what one session start showed (fail-silent); also drops receipts past the retention window. */
export function receiptAdd(
  store: Store,
  r: { sessionId: string; namespace: string; client: string; shown: Array<{ id: number; why: string; tokens: number }> },
  now: number = Date.now()
): void {
  const days = accessLogDays();
  if (!r.sessionId || !r.shown.length || days === 0) return;
  const db = store.captureDb();
  // Session start must never wait behind another process's write lock for a receipt: fail fast, say so, keep going.
  const prev = Number((db.prepare("PRAGMA busy_timeout").get() as Record<string, unknown> | undefined)?.timeout ?? 0);
  try {
    db.exec("PRAGMA busy_timeout = 0;");
    db.exec(SCHEMA);
    db.prepare("DELETE FROM memory_receipts WHERE at < ?").run(new Date(now - days * 86_400_000).toISOString());
    db.prepare("DELETE FROM memory_receipts WHERE session_id = ?").run(r.sessionId);
    const ins = db.prepare("INSERT OR REPLACE INTO memory_receipts (session_id, note_id, namespace, client, at, rank, why, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const at = new Date(now).toISOString();
    r.shown.forEach((n, i) => ins.run(r.sessionId, n.id, r.namespace, r.client, at, i + 1, n.why, Math.max(0, Math.round(n.tokens))));
  } catch (e) {
    process.stderr.write(`monomem: receipt not saved (${(e as Error).message})\n`);
  } finally {
    try {
      db.exec(`PRAGMA busy_timeout = ${prev};`);
    } catch {
      /* the connection is gone; nothing to restore */
    }
  }
}

function hasTable(store: Store): boolean {
  return !!store.captureDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_receipts'").get();
}
const nsWhere = (ns?: string[]): string => (ns ? ` AND namespace IN (${ns.map(() => "?").join(",") || "NULL"})` : "");

/** Recent sessions, newest first, optionally limited to some namespaces. */
export function receiptList(store: Store, namespaces?: string[], limit = 20): ReceiptSummary[] {
  if (!hasTable(store)) return [];
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  if (currentCeiling() !== undefined) {
    // A caller with a sensitivity ceiling must not count (or weigh) notes above it: tally the rows one by one without those.
    const all = store
      .captureDb()
      .prepare(`SELECT session_id, note_id, namespace, client, at, tokens FROM memory_receipts WHERE 1=1${nsWhere(namespaces)} ORDER BY at DESC, session_id DESC`)
      .all(...(namespaces ?? [])) as Array<{ session_id: string; note_id: number; namespace: string; client: string; at: string; tokens: number }>;
    const bySession = new Map<string, ReceiptSummary>();
    for (const r of all) {
      if (store.hiddenFromCaller(Number(r.note_id))) continue;
      const s = bySession.get(r.session_id);
      if (s) {
        s.notes += 1;
        s.tokens += Number(r.tokens);
      } else bySession.set(r.session_id, { session_id: r.session_id, namespace: r.namespace, client: r.client, at: r.at, notes: 1, tokens: Number(r.tokens) });
    }
    return [...bySession.values()].slice(0, cap);
  }
  const rows = store
    .captureDb()
    .prepare(
      `SELECT session_id, MIN(namespace) AS namespace, MIN(client) AS client, MIN(at) AS at, COUNT(*) AS notes, SUM(tokens) AS tokens
       FROM memory_receipts WHERE 1=1${nsWhere(namespaces)} GROUP BY session_id ORDER BY at DESC, session_id DESC LIMIT ?`
    )
    .all(...(namespaces ?? []), cap) as unknown as ReceiptSummary[];
  return rows.map((r) => ({ ...r, notes: Number(r.notes), tokens: Number(r.tokens) }));
}

/** One session's receipt with titles looked up now, or null when there is none (or it is outside `namespaces`). */
export function receiptGet(store: Store, sessionId: string, namespaces?: string[]): Receipt | null {
  if (!hasTable(store)) return null;
  const db = store.captureDb();
  const rows = db
    .prepare(`SELECT note_id, namespace, client, at, rank, why, tokens FROM memory_receipts WHERE session_id = ?${nsWhere(namespaces)} ORDER BY rank`)
    .all(sessionId, ...(namespaces ?? [])) as Array<{ note_id: number; namespace: string; client: string; at: string; rank: number; why: string; tokens: number }>;
  if (!rows.length) return null;
  const notes = rows.filter((r) => !store.hiddenFromCaller(Number(r.note_id))).map((r): ReceiptNote => {
    const n = store.readVisible(Number(r.note_id), { hideArchived: true });
    const state = n ? "ok" : "gone";
    return { id: Number(r.note_id), rank: Number(r.rank), why: r.why, tokens: Number(r.tokens), title: n ? n.title : null, state };
  });
  if (!notes.length && currentCeiling() !== undefined) return null; // every note of it is above the caller's ceiling
  const f = rows[0];
  return { session_id: sessionId, namespace: f.namespace, client: f.client, at: f.at, tokens: notes.reduce((a, n) => a + n.tokens, 0), notes };
}

// ---- Savings card ----------------------------------------------------------------------------------------------

export const esc = (v: unknown): string =>
  (typeof v === "number" ? v.toLocaleString("en-US") : String(v)).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/&#60;/g, "&lt;").replace(/&#62;/g, "&gt;");

export const CARD_REPO = "github.com/calasdan-sketch/monomem";
const SLATE = "#9FB3C4";

/** The official Calas mark (calas-vault Brand/dc-logo, white on dark; never redraw it), embedded so the card is one file. */
const CALAS_MARK_WHITE = "data:image/png;base64,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";

/** The Calas mark and the two-tone lowercase wordmark, as on the dashboard. */
export function cardBrand(label = ""): string {
  return (
    `<image x="34" y="22" width="25" height="35" href="${CALAS_MARK_WHITE}"/>` +
    `<text x="80" y="56" font-size="30" font-weight="700" fill="#FFFFFF">mono<tspan fill="#F0C171">mem</tspan>` +
    (label ? `<tspan font-size="17" font-weight="400" fill="${SLATE}"> ${esc(label)}</tspan>` : "") +
    `</text>`
  );
}

/** One footer line on every card: how to get it, and where it lives. */
export function cardFooter(y = 344): string {
  return `<text x="40" y="${y}" font-size="12" fill="${SLATE}"><tspan font-weight="600" fill="#F0C171">npx monomem setup</tspan> &#183; ${esc(CARD_REPO)}</text>`;
}

/** Greedy word wrap for SVG (which does not wrap): at most `max` characters a line. */
export function wrapText(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (lines.length && lines[lines.length - 1].length + 1 + w.length <= max) lines[lines.length - 1] += " " + w;
    else lines.push(w);
  }
  return lines;
}

/** Wrapped text as one <text> with a <tspan> per line. */
export function svgLines(text: string, x: number, y: number, max: number, attrs: string, lineHeight = 17): string {
  const t = wrapText(text, max).map((l, i) => `<tspan x="${x}"${i ? ` dy="${lineHeight}"` : ""}>${esc(l)}</tspan>`).join("");
  return `<text x="${x}" y="${y}" ${attrs}>${t}</text>`;
}

/** A 640x360 SVG with the meter's real totals. Estimates at ~4 chars/token, exactly as meter.ts computes them. */
export function renderCard(t: MeterTotals): string {
  const stat = (x: number, n: unknown, label: string): string =>
    `<text x="${x}" y="188" font-size="44" font-weight="700" fill="#F0C171">${esc(n)}</text>` +
    `<text x="${x}" y="214" font-size="15" fill="#FFFFFF">${esc(label)}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" font-family="system-ui, -apple-system, Segoe UI, sans-serif">` +
    `<rect width="640" height="360" rx="18" fill="#0B2E45"/>` +
    cardBrand() +
    `<text x="40" y="104" font-size="15" fill="#FFFFFF">What local memory saved my agents</text>` +
    stat(40, t.sessions, Number(t.sessions) === 1 ? "session" : "sessions") +
    stat(230, t.injected_tokens, "tokens injected") +
    stat(430, t.saved_tokens, "est. tokens saved") +
    `<text x="40" y="256" font-size="13" fill="${SLATE}"><tspan x="40">estimate, ~4 chars/token. Saved = full text of the notes shown, minus</tspan><tspan x="40" dy="18">the tokens injected.</tspan></text>` +
    `<text x="40" y="312" font-size="15" font-weight="600" fill="#F0C171">No network calls by Monomem by default</text>` +
    cardFooter() +
    `</svg>\n`
  );
}

// ---- CLI -------------------------------------------------------------------------------------------------------

async function openStore(): Promise<Store> {
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  return new Store(DB_PATH);
}

/** `monomem meter [--json] [--card [path]]` */
export async function meterCmd(args: string[]): Promise<void> {
  const store = await openStore();
  try {
    const m = meterStats(store);
    const ci = args.indexOf("--card");
    if (ci >= 0) {
      const next = args[ci + 1];
      const path = next && !next.startsWith("-") ? next : "monomem-card.svg";
      writeFileSync(path, renderCard(m.totals));
      console.log(`wrote ${path}`);
    } else console.log(args.includes("--json") ? JSON.stringify(m, null, 2) : meterLine(m));
  } finally {
    store.close();
  }
}

/** "2026-11-05 14:03:00 -06:00": the reader's local time with its UTC offset (the same format `as-of` prints); the stored string if it does not parse. */
export const localTime = (iso: string): string => localTimeOffset(iso);
/** `{files,kw 3d}` -> "files, kw; 3 days old"; `{recent 0d}` -> "recent; today". Anything else is shown as stored. */
export function whyText(why: string): string {
  const m = /^\{(?:(.*?) )?(\d+)d\}$/.exec(why);
  if (!m) return why;
  const days = Number(m[2]);
  const age = days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} old`;
  return `${m[1] ? m[1].split(",").join(", ") + "; " : ""}${age}`;
}
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** `monomem receipts [session-id] [--json]` */
export async function receiptsCmd(args: string[]): Promise<void> {
  const store = await openStore();
  try {
    const json = args.includes("--json");
    const id = args.find((a) => !a.startsWith("-"));
    if (id) {
      const r = receiptGet(store, id);
      if (!r) {
        console.error(`no receipt for session ${printable(id)} (kept ${accessLogDays()} days, MONOMEM_ACCESS_LOG_DAYS)`);
        process.exit(1);
      }
      if (json) return console.log(JSON.stringify(r, null, 2));
      console.log(`session ${printable(r.session_id)}  ${localTime(r.at)}  ${printable(r.client || "-")}${r.namespace ? `  namespace ${printable(r.namespace)}` : ""}`);
      console.log(`  ${plural(r.notes.length, "note")} shown, ~${r.tokens} tokens of note text (the whole injection is a little larger: it adds headers and a footer; see \`monomem meter\`)`);
      for (const n of r.notes) console.log(`  ${n.rank}. #${n.id} ~${n.tokens} tokens, why: ${whyText(n.why)}  ${n.state === "ok" ? printable(n.title) : "(deleted, archived or hidden since)"}`);
      return;
    }
    const list = receiptList(store);
    if (json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log("No receipts yet: they are written by the next session the SessionStart hook runs for.");
    for (const s of list) console.log(`${printable(s.session_id)}  ${localTime(s.at)}  ${plural(s.notes, "note")}, ~${s.tokens} tokens of note text  ${printable(s.client || "-")}`);
  } finally {
    store.close();
  }
}
