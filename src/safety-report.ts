// `monomem safety-report --out report.html`: a one-page, shareable check-up. Static HTML: no scripts, no pictures, no
// links, no fonts from elsewhere. It contains counts and settings only: never a note's text, never a key.
import type { Store } from "./store.js";
import { qualityReport } from "./quality.js";
import { backupAgeDays } from "./digest.js";
import { isLoopback, type TokenEntry } from "./config.js";
import { keyPath } from "./crypto.js";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export interface Check {
  name: string;
  status: "Pass" | "Warn";
  detail: string;
  /** The command that fixes it (Warn only). */
  fix?: string;
}

export interface SafetyInput {
  store: Store;
  dbPath: string;
  dataDir: string;
  bindHost: string;
  tokens: TokenEntry[];
  version: string;
  node: string;
  platform: string;
  now?: Date;
  stdioCeiling?: string;
}

export async function safetyChecks(i: SafetyInput): Promise<Check[]> {
  const out: Check[] = [];
  const loop = isLoopback(i.bindHost);
  out.push(loop
    ? { name: "Who can reach the server", status: "Pass", detail: `It listens only on this computer (loopback), so no other computer can reach it.` }
    : { name: "Who can reach the server", status: "Warn", detail: `It is set to listen beyond this computer, so other computers on the network may reach it. Every request still needs a key.`, fix: "set MONOMEM_BIND=127.0.0.1 unless you need other machines (and keep it behind a tunnel with a login)" });

  const apps = i.tokens.filter((t) => t.label !== "primary");
  const open = apps.filter((t) => t.scope !== "admin" && t.max_sensitivity === undefined);
  const adminApps = apps.filter((t) => t.scope === "admin");
  // Counts only: app names, namespace names and addresses are not written into a page people may share.
  const pinned = apps.filter((t) => t.namespace).length;
  const list = `${apps.length - open.length} with a limit${pinned ? `, ${pinned} confined to one namespace` : ""}.`;
  out.push(open.length || adminApps.length
    ? { name: "Keys and their limits", status: "Warn", detail: `${apps.length} app key(s). ${open.length} can see everything without a limit, ${adminApps.length} are administrators. ${list} (App names are left out of this page on purpose.)`, fix: "monomem token list   (then give each app a limit: monomem token add <name> --max internal)" }
    : { name: "Keys and their limits", status: "Pass", detail: apps.length ? `${apps.length} app key(s), all with a limit. ${pinned ? `${pinned} confined to one namespace.` : ""}` : "No separate app keys; only the main key exists." });

  const priv = i.store.hasPrivateNotes();
  out.push(priv && !i.stdioCeiling
    ? { name: "Apps connected directly (stdio)", status: "Warn", detail: "Private notes exist, and an app wired the usual way (monomem mcp) is not limited: it sees them.", fix: "monomem connect <app> --max internal   (for any app that should not see private notes)" }
    : { name: "Apps connected directly (stdio)", status: "Pass", detail: priv ? `Direct connections are capped at ${i.stdioCeiling}.` : "No private notes exist, so a direct connection exposes nothing extra." });

  const enc = existsSync(keyPath(dirname(i.dbPath)));
  out.push(enc
    ? { name: "Encryption at rest", status: "Pass", detail: "Note bodies are encrypted in the database file." }
    : { name: "Encryption at rest", status: "Warn", detail: "Note bodies are stored as plain text in the database file (anyone who can read the file can read them).", fix: "monomem encrypt enable" });

  const age = backupAgeDays(i.dataDir);
  out.push(age !== null && age <= 7
    ? { name: "Backup", status: "Pass", detail: `Last backup ${Math.floor(age)} day(s) ago.` }
    : { name: "Backup", status: "Warn", detail: age === null ? "No backup was found." : `Last backup ${Math.floor(age)} days ago.`, fix: "monomem backup" });

  const q = await qualityReport(i.store);
  out.push(q.counts.quarantined === 0
    ? { name: "Held writes", status: "Pass", detail: "Nothing is waiting for review." }
    : { name: "Held writes", status: "Warn", detail: `${q.counts.quarantined} write(s) are waiting for review.`, fix: "monomem quarantine list" });
  out.push(q.counts.pii === 0
    ? { name: "Personal-data suggestions", status: "Pass", detail: "The pattern scan found nothing it would suggest labelling private (it can miss things)." }
    : { name: "Personal-data suggestions", status: "Warn", detail: `${q.counts.pii} note(s) look like they hold personal data and are not private (pattern-based; may be wrong).`, fix: "monomem pii scan" });

  let integrity = "unknown";
  try {
    integrity = String((i.store.captureDb().prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check);
  } catch {
    /* leave unknown */
  }
  out.push(integrity === "ok"
    ? { name: "Database check", status: "Pass", detail: "The database file passes SQLite's own integrity check." }
    : { name: "Database check", status: "Warn", detail: `The integrity check said: ${integrity}.`, fix: "monomem doctor" });
  return out;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderSafetyHtml(checks: Check[], meta: { version: string; date: string; node: string; platform: string }): string {
  const warns = checks.filter((c) => c.status === "Warn").length;
  const rows = checks
    .map(
      (c) =>
        `<tr class="${c.status.toLowerCase()}"><td><b>${esc(c.name)}</b></td><td class="s">${c.status}</td><td>${esc(c.detail)}${c.fix ? `<div class="fix">Fix: <code>${esc(c.fix)}</code></div>` : ""}</td></tr>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monomem safety report</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;background:#fff;color:#161b29}
h1{font-size:1.4rem;margin-bottom:.2rem} .meta{color:#505b78;font-size:.85rem;margin-bottom:1rem}
table{width:100%;border-collapse:collapse} td{padding:.5rem .6rem;border-bottom:1px solid #d9deea;vertical-align:top}
.s{font-weight:700;white-space:nowrap} tr.pass .s{color:#0f7a5c} tr.warn .s{color:#8a5a00}
.fix{margin-top:.3rem;color:#505b78} code{background:#eef1f8;padding:0 .3rem;border-radius:4px}
.note{margin-top:1.2rem;color:#505b78;font-size:.85rem}
@media (prefers-color-scheme:dark){body{background:#0c0f16;color:#e8ecf5}td{border-color:#232a3b}.meta,.fix,.note{color:#93a0bd}code{background:#1d2435}tr.pass .s{color:#35d0a5}tr.warn .s{color:#f5b84b}}
</style></head><body>
<h1>Monomem safety report</h1>
<div class="meta">Monomem ${esc(meta.version)} &middot; ${esc(meta.date)} &middot; Node ${esc(meta.node)} on ${esc(meta.platform)} &middot; ${warns === 0 ? "all checks passed" : `${warns} thing(s) to look at`}</div>
<table>
${rows}
</table>
<p class="note">This report holds counts and yes/no settings only. It contains no note text, no keys, and no app, namespace or address names. It is a check-up of this one installation, not a certification or a guarantee, and the personal-data scan is pattern-based.</p>
</body></html>
`;
}
