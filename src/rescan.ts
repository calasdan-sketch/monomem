// `monomem check --rescan`: run TODAY's memory linter over every note already stored. A note stored last month was checked
// by last month's linter; after an upgrade a newer pattern may match it. Notes that now match are held with an ordinary "this
// looks wrong" flag (store/flags.ts): the note itself is not changed or deleted, it leaves session start, and
// `monomem review keep <id>` puts it back. A note you pinned or confirmed is reported but left as it is.
// Also keeps a tiny record (<data folder>/lint-scan.json) of the version that last scanned, so `monomem doctor` can say once
// after an upgrade that a re-scan is worth running.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "./store.js";
import { lintContent } from "./lint.js";
import { printable } from "./security.js";
import { hasOpenFlag, holdByRescan } from "./store/flags.js";

export const RESCAN_WRITER = "monomem:rescan";
export const scanMarkerPath = (dataDir: string): string => join(dataDir, "lint-scan.json");

export interface ScanMarker {
  /** Version that last re-scanned every note ("" = never). */
  scanned_version: string;
  scanned_at: string;
  /** Version for which doctor already suggested a re-scan (so it says so once, not on every run). */
  suggested_version?: string;
}

export function readScanMarker(dataDir: string): ScanMarker | null {
  try {
    const p = scanMarkerPath(dataDir);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<ScanMarker>;
    return typeof j.scanned_version === "string" ? { scanned_version: j.scanned_version, scanned_at: String(j.scanned_at ?? ""), ...(typeof j.suggested_version === "string" ? { suggested_version: j.suggested_version } : {}) } : null;
  } catch {
    return null;
  }
}

export function writeScanMarker(dataDir: string, m: ScanMarker): void {
  const p = scanMarkerPath(dataDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m) + "\n", { mode: 0o600 });
  renameSync(tmp, p);
}

export interface RescanHit {
  id: number;
  namespace: string;
  title: string;
  label: string;
  /** "held" (flagged now), "already" (an open flag or an earlier re-scan hold), "kept" (pinned or confirmed by a person: only reported), "would" (dry run). */
  action: "held" | "already" | "kept" | "would";
}
export interface RescanResult {
  scanned: number;
  hits: RescanHit[];
}

/** Scan every live note; hold (unless `dryRun`) the ones the current linter flags as injection, secret or tool-steering. */
export function rescanNotes(store: Store, opts: { namespace?: string; dryRun?: boolean }): RescanResult {
  const hits: RescanHit[] = [];
  let scanned = 0;
  const ids: number[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = store.listIds({ namespace: opts.namespace, limit: 200, offset });
    ids.push(...page);
    if (page.length < 200) break;
  }
  for (const id of ids) {
    const n = store.read(id); // gate-ok: the owner at a terminal checking their own store; nothing is returned to an agent
    if (!n) continue;
    scanned++;
    const found = lintContent({ title: n.title, body: n.body, tags: n.tags, writer: n.written_by }).filter((f) => f.category === "injection" || f.category === "secret");
    if (!found.length) continue;
    const label = printable([...new Set(found.map((f) => f.label))].slice(0, 3).join(", "), 120);
    const base = { id: n.id, namespace: n.namespace, title: printable(n.title, 80), label };
    if (n.pinned || n.confirmed_kind === "human") {
      hits.push({ ...base, action: "kept" });
      continue;
    }
    if (hasOpenFlag(store, n.id, n.rev)) {
      hits.push({ ...base, action: "already" });
      continue;
    }
    if (opts.dryRun) {
      hits.push({ ...base, action: "would" });
      continue;
    }
    holdByRescan(store, n, RESCAN_WRITER, `re-scan with a newer memory linter: ${label}`);
    hits.push({ ...base, action: "held" });
  }
  return { scanned, hits };
}

/** The plain-words summary a person reads. */
export function rescanSummary(r: RescanResult, version: string, dryRun: boolean): string[] {
  const by = (a: RescanHit["action"]): RescanHit[] => r.hits.filter((h) => h.action === a);
  const out = [`Re-checked ${r.scanned} note${r.scanned === 1 ? "" : "s"} with the memory linter of version ${version}.`];
  if (!r.hits.length) return [...out, "None of them matches a pattern the linter holds today. Nothing was changed."];
  const held = by("held");
  const would = by("would");
  const kept = by("kept");
  const already = by("already");
  out.push(`${r.hits.length} now match${r.hits.length === 1 ? "es" : ""} a pattern the linter holds.`);
  if (dryRun) out.push(`Dry run: ${would.length} would be held. Nothing was changed. Run without --dry-run to hold them.`);
  else if (held.length) out.push(`Held ${held.length} for your review (they stay stored, they just stop going into session start): look with "monomem review", keep one with "monomem review keep <id>". Nothing was deleted or edited.`);
  if (already.length) out.push(`${already.length} were already flagged.`);
  if (kept.length) out.push(`${kept.length} left as they are because a person pinned or confirmed them (check them yourself).`);
  for (const h of r.hits.slice(0, 30)) out.push(`  note #${h.id} "${h.title}": ${h.label} (${{ held: "held", already: "already flagged", kept: "pinned or confirmed, left as is", would: "would be held" }[h.action]})`);
  if (r.hits.length > 30) out.push(`  ... and ${r.hits.length - 30} more (--json lists all)`);
  return out;
}
