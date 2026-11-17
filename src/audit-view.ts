// Reading the audit log back: who did what, when. The log holds metadata only (operation, note id, namespace, count,
// the key's label); never note text, never a search query, never a key. This reads the current file and the rotated ones.
import { existsSync, readFileSync } from "node:fs";
import { auditPath, printable } from "./security.js";

export interface AuditEntry {
  ts: string;
  op: string;
  id?: number;
  namespace?: string;
  bytes?: number;
  label?: string;
  kind?: string;
  detail?: string;
}

export interface AuditQuery {
  sinceMs?: number;
  op?: string;
  label?: string;
  limit?: number;
}

/** "24h", "7d", "30m" -> milliseconds, or null. */
export function parseWindow(s: string): number | null {
  const m = /^(\d+)\s*(m|h|d)$/i.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as "m" | "h" | "d"];
}

export function readAudit(q: AuditQuery = {}, now = Date.now(), path = auditPath()): { entries: AuditEntry[]; truncated: boolean } {
  const keep = Math.max(1, Math.floor(Number(process.env.MONOMEM_AUDIT_KEEP || 5)));
  const files = [path];
  for (let i = 1; i <= keep; i++) files.push(`${path}.${i}`);
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const out: AuditEntry[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let e: AuditEntry;
      try {
        e = JSON.parse(line) as AuditEntry;
      } catch {
        continue; // a torn or foreign line
      }
      if (typeof e.ts !== "string" || typeof e.op !== "string") continue;
      if (q.sinceMs !== undefined && Date.parse(e.ts) < now - q.sinceMs) continue;
      if (q.op && e.op !== q.op && !e.op.startsWith(q.op + ".")) continue;
      if (q.label && e.label !== q.label) continue;
      out.push(e);
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { entries: out.slice(0, limit), truncated: out.length > limit };
}

/** Plain words for the audit op codes people meet most; any other code is shown with its dots and dashes as spaces. */
const OP_WORDS: Record<string, string> = {
  quarantine: "held", "quarantine-approve": "held, approved", "quarantine-reject": "held, rejected", "quarantine-keep": "held, kept",
  supersede: "replaced", "supersede-undo": "replace undone", "write-refused": "write refused", "mcp.connect": "app connected",
  "sign-start": "signing started", "taint-clear": "outside label cleared", "retro-taint": "outside label added",
  "token.add": "app key added", "token.remove": "app key removed", "sweep-expire": "expired notes archived",
  "sweep-decay": "old captures archived", "changes.ack": "changes confirmed", "spool-drop": "capture spool dropped",
};
const opWord = (op: string): string => OP_WORDS[op] ?? op.replace(/[._-]+/g, " ");

/** Who, in plain words: a keyless local app by its name (stdio:claude-code), else the key's label, else the person. */
function byWho(label: string | undefined): string {
  if (!label) return "by you (command line) or the server";
  if (label === "stdio") return "by an app with no key (local)";
  if (label.startsWith("stdio:")) return `by ${printable(label.slice(6), 40)} (local app, no key)`;
  return `by ${printable(label, 80)}`;
}

export function renderAudit(entries: AuditEntry[]): string {
  if (!entries.length) return "No matching entries.";
  return entries
    .map((e) => `${e.ts.slice(0, 19).replace("T", " ")}  ${opWord(e.op).padEnd(22)} ${byWho(e.label)}${e.namespace ? `  [${printable(e.namespace, 100)}]` : ""}${e.id !== undefined ? `  #${e.id}` : ""}${e.kind === "read" || e.kind === "search" ? `  ${e.bytes ?? 0} result(s)` : ""}`)
    .join("\n");
}
