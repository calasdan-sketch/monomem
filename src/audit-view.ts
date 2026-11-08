// Reading the audit log back: who did what, when. The log holds metadata only (operation, note id, namespace, count,
// the key's label); never note text, never a search query, never a key. This reads the current file and the rotated ones.
import { existsSync, readFileSync } from "node:fs";
import { auditPath } from "./security.js";

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

export function renderAudit(entries: AuditEntry[]): string {
  if (!entries.length) return "No matching entries.";
  return entries
    .map((e) => `${e.ts.slice(0, 19).replace("T", " ")}  ${e.op.padEnd(14)} ${e.label ? `by ${e.label}` : "by (no key: command line or server)"}${e.namespace ? `  [${e.namespace}]` : ""}${e.id !== undefined ? `  #${e.id}` : ""}${e.kind === "read" || e.kind === "search" ? `  ${e.bytes ?? 0} result(s)` : ""}`)
    .join("\n");
}
