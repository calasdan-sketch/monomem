// Memory tidiness (0-100, the dashboard card) and the plain-language digest. Both are SUGGESTIONS: they read, count and explain; they never
// change a note or a label. The formula is fixed and printed with the score. (The A-F health grade for the setup is health.ts.)
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "./store.js";
import { qualityReport, type QualityReport, type QualityType } from "./quality.js";
import { runChanges } from "./changes.js";

export interface HealthInput {
  counts: Record<QualityType, number>;
  /** Keys (not admin) that can see everything. */
  tokensWithoutCeiling: number;
  /** Days since the last backup; null = none found. */
  backupAgeDays: number | null;
  /** Notes in the store (any state). With none there is nothing a backup could save, so a missing backup costs nothing. */
  noteCount?: number;
}

export interface Deduction {
  category: string;
  points: number;
  cap: number;
  detail: string;
}

export interface Health {
  score: number;
  deductions: Deduction[];
  formula: string[];
}

/** points per finding, cap per category */
const RULES: Array<{ category: string; type?: QualityType; each: number; cap: number; what: string }> = [
  { category: "duplicates", type: "duplicate", each: 2, cap: 15, what: "groups of near-identical notes" },
  { category: "older duplicates", type: "stale_twin", each: 1, cap: 10, what: "old notes with a newer note on the same subject" },
  { category: "held writes", type: "quarantined", each: 3, cap: 15, what: "writes held for review" },
  { category: "lint", type: "lint", each: 3, cap: 15, what: "notes the safety scan flags" },
  { category: "personal data suggestions", type: "pii", each: 1, cap: 15, what: "notes that look like personal data and are not private" },
  { category: "empty notes", type: "empty", each: 2, cap: 10, what: "notes with a title and no text" },
  { category: "restated, not retired", type: "restated", each: 1, cap: 10, what: "old notes their own writer restated in a newer note without retiring them" },
];

export const HEALTH_FORMULA = [
  "Start at 100. Take off points per finding, each category has its own cap:",
  ...RULES.map((r) => `  ${r.category}: ${r.each} per finding (${r.what}), at most ${r.cap}`),
  "  keys without a limit: 5 per key that is not an administrator and sees everything, at most 15",
  "  backup: 10 if the last one is over 30 days old, 5 if over 7 days old (none yet costs nothing: the server makes one every day)",
  "The score never goes below 0.",
];

export function computeHealth(i: HealthInput): Health {
  const deductions: Deduction[] = [];
  for (const r of RULES) {
    const n = i.counts[r.type!] ?? 0;
    if (n > 0) deductions.push({ category: r.category, points: Math.min(r.cap, n * r.each), cap: r.cap, detail: `${r.what} (${n})` });
  }
  if (i.tokensWithoutCeiling > 0) deductions.push({ category: "keys without a limit", points: Math.min(15, i.tokensWithoutCeiling * 5), cap: 15, detail: `${i.tokensWithoutCeiling} key(s) that see everything` });
  // No backup yet costs nothing (1.6.0): the server backs up every day by itself (backup-schedule.ts), so a new store is not
  // punished for something it is about to get. An OLD last backup still counts: the daily copies have stopped.
  if (i.noteCount === 0 || i.backupAgeDays === null) {
    /* nothing to count */
  } else if (i.backupAgeDays > 30) deductions.push({ category: "backup", points: 10, cap: 10, detail: `last backup ${Math.floor(i.backupAgeDays)} days ago` });
  else if (i.backupAgeDays > 7) deductions.push({ category: "backup", points: 5, cap: 10, detail: `last backup ${Math.floor(i.backupAgeDays)} days ago` });
  const score = Math.max(0, 100 - deductions.reduce((a, d) => a + d.points, 0));
  return { score, deductions, formula: HEALTH_FORMULA };
}

const MARKER = ".last-backup";

/** Days since the newest backup: the marker `monomem backup` leaves in the data folder, or a monomem-backup-* folder in the home folder. */
export function backupAgeDays(dataDir: string, now = Date.now(), home = homedir()): number | null {
  let newest = 0;
  try {
    const t = Date.parse(readFileSync(join(dataDir, MARKER), "utf8").trim());
    if (Number.isFinite(t)) newest = t;
  } catch {
    /* no marker */
  }
  try {
    for (const f of readdirSync(home)) {
      if (!f.startsWith("monomem-backup")) continue;
      const p = join(home, f);
      if (existsSync(join(p, "state.db"))) newest = Math.max(newest, statSync(join(p, "state.db")).mtimeMs);
    }
  } catch {
    /* unreadable home */
  }
  return newest ? Math.max(0, (now - newest) / 86400000) : null;
}
export const backupMarkerName = MARKER;

export interface Insights {
  health: Health;
  report: QualityReport;
}

export async function insights(store: Store, tokensWithoutCeiling: number, dataDir: string, namespaces?: string[]): Promise<Insights> {
  const report = await qualityReport(store, namespaces);
  return { health: computeHealth({ counts: report.counts, tokensWithoutCeiling, backupAgeDays: backupAgeDays(dataDir), noteCount: store.list({ limit: 1, includeArchived: true, includeSuperseded: true, includeDistrusted: true }).total }), report };
}

// ---- digest -------------------------------------------------------------------------------------------------------

export interface Digest {
  since: string;
  until: string;
  counts: { created: number; updated: number; deleted: number };
  byWriter: Record<string, { created: number; updated: number; deleted: number }>;
  topIssues: string[];
}

const TYPE_WORDS: Record<QualityType, [string, string]> = {
  duplicate: ["group of notes says the same thing", "groups of notes say the same thing"],
  stale_twin: ["old note has a newer one on the same subject", "old notes have newer ones on the same subject"],
  quarantined: ["write is waiting for your review", "writes are waiting for your review"],
  lint: ["note was flagged by the safety scan", "notes were flagged by the safety scan"],
  decay: ["captured item is about to be archived", "captured items are about to be archived"],
  pii: ["note may hold personal data", "notes may hold personal data"],
  contradiction: ["pair of notes may disagree", "pairs of notes may disagree"],
  empty: ["note has a title and no text", "notes have a title and no text"],
  restated: ["old note was restated but never retired", "old notes were restated but never retired"],
};

/** "yesterday" = since local midnight yesterday; otherwise what the change feed accepts (24h, 7d, an ISO time, last). */
export function resolveSince(s: string, now = new Date()): string {
  if (s === "yesterday") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return d.toISOString();
  }
  return s;
}

export async function buildDigest(store: Store, since: string, opts: { namespaces?: string[]; consumer?: string } = {}): Promise<Digest> {
  const base = { namespaces: opts.namespaces, limit: 500 };
  let page = runChanges(store, { ...base, since: resolveSince(since), consumer: opts.consumer ?? "digest" });
  const first = page;
  const byWriter: Digest["byWriter"] = {};
  for (;;) {
    for (const e of page.changes) {
      const w = e.written_by || "(unknown)";
      const row = (byWriter[w] ??= { created: 0, updated: 0, deleted: 0 });
      row[e.kind]++;
    }
    if (!page.nextCursor) break;
    page = runChanges(store, { ...base, cursor: page.nextCursor });
  }
  const report = await qualityReport(store, opts.namespaces);
  const order = Object.keys(TYPE_WORDS) as QualityType[];
  const topIssues = order
    .map((t, i) => ({ t, n: report.counts[t], i }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, 3)
    .map((x) => `${x.n} ${TYPE_WORDS[x.t][x.n === 1 ? 0 : 1]}`);
  return { since: first.since, until: first.until, counts: { created: first.counts.created, updated: first.counts.updated, deleted: first.counts.deleted }, byWriter, topIssues };
}

export function renderDigest(d: Digest): string {
  const c = d.counts;
  const lines = [`Since ${d.since.slice(0, 16).replace("T", " ")}: ${c.created} added, ${c.updated} edited, ${c.deleted} deleted.`];
  const writers = Object.keys(d.byWriter).sort();
  for (const w of writers) {
    const r = d.byWriter[w];
    lines.push(`  ${w}: ${r.created} added, ${r.updated} edited, ${r.deleted} deleted`);
  }
  if (!writers.length) lines.push("  Nothing changed.");
  lines.push(d.topIssues.length ? "Worth a look:" : "Nothing needs your attention.");
  d.topIssues.forEach((t, i) => lines.push(`  ${i + 1}. ${t}`));
  if (d.topIssues.length) lines.push("  Details and the command for each: monomem review duplicates");
  return lines.join("\n");
}
