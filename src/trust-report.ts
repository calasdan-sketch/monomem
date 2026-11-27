// `monomem report`: ONE self-contained HTML trust report (no scripts, no images, no links, no note text). Every number is computed
// when the report is made: the scenario counts come from a real `bench` run, the attack replay from a real `drill` on a copy of
// the store, the writer, held and rollback counts from the store itself. The "does not do" lines are the benchmark's own LIMITS
// and the README's own limits block, read from the files, not retyped here. Nothing is a hand-written number.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SUITES } from "./bench/types.js";
import { SUITE_NAMES, headline, type Report } from "./bench/report.js";

export interface WriterRow {
  writer: string;
  notes: number;
  events: Record<string, number>;
  last_event: string;
}
export interface StoreFacts {
  writers: WriterRow[];
  held_now: number;
  notes: number;
}
export interface DrillFacts {
  attacks: number;
  held: number;
  blocked: number;
  warned: number;
  reached: number;
  known_misses: string[];
}
export interface TrustInput {
  version: string;
  date: string;
  node: string;
  platform: string;
  bench: Report;
  drill: DrillFacts | null;
  store: StoreFacts | null;
  /** Test files in the source checkout; null in the npm package (it ships none). */
  testFiles: number | null;
  /** Bullets of the README's "What it does not do" block; [] when the README is not shipped. */
  readmeLimits: string[];
}

export const esc = (s: unknown): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Writer, held and rollback history read from the store (read-only connection; no note text is selected). */
export function readStoreFacts(dbPath: string): StoreFacts | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    const rows = new Map<string, WriterRow>();
    const row = (w: string): WriterRow => {
      let r = rows.get(w);
      if (!r) rows.set(w, (r = { writer: w, notes: 0, events: {}, last_event: "" }));
      return r;
    };
    for (const r of db.prepare("SELECT written_by AS w, COUNT(*) AS c FROM notes GROUP BY written_by").all() as Array<{ w: string; c: number }>) row(r.w || "(unknown)").notes = Number(r.c);
    let events: Array<{ w: string; e: string; c: number; at: string }> = [];
    try {
      events = db.prepare("SELECT writer AS w, event AS e, COUNT(*) AS c, MAX(at) AS at FROM writer_events GROUP BY writer, event").all() as typeof events;
    } catch {
      /* an older store has no writer_events: the history sections just stay empty */
    }
    for (const e of events) {
      const r = row(e.w || "(unknown)");
      r.events[e.e] = Number(e.c);
      if (e.at > r.last_event) r.last_event = e.at;
    }
    let held = 0;
    try {
      held = Number((db.prepare("SELECT COUNT(*) AS c FROM quarantine").get() as { c: number }).c);
    } catch {
      /* no quarantine table yet */
    }
    const notes = Number((db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
    return { writers: [...rows.values()].sort((a, b) => b.notes - a.notes || a.writer.localeCompare(b.writer)), held_now: held, notes };
  } finally {
    db.close();
  }
}

/** The bullets under "What it does not do." in the README. */
export function readmeLimitLines(readme: string): string[] {
  const i = readme.indexOf("**What it does not do.**");
  if (i < 0) return [];
  const out: string[] = [];
  for (const line of readme.slice(i).split(/\r?\n/).slice(1)) {
    if (/^\s*-\s/.test(line)) out.push(line.replace(/^\s*-\s*/, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*]/g, ""));
    else if (out.length && line.trim() === "") break;
  }
  return out;
}

export function countTestFiles(root: string | null): number | null {
  if (!root || !existsSync(join(root, "test"))) return null;
  return readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts")).length;
}

export function readReadmeLimits(root: string | null): string[] {
  if (!root || !existsSync(join(root, "README.md"))) return [];
  return readmeLimitLines(readFileSync(join(root, "README.md"), "utf8"));
}

const list = (xs: string[]): string => (xs.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "<p>none recorded</p>");

function writersTable(s: StoreFacts | null): string {
  if (!s) return "<p>No store was found here, so there is no per-writer history. (Counts only appear for a real store.)</p>";
  const head = "<tr><th>Writer</th><th>Notes</th><th>Held, approved</th><th>Held, rejected</th><th>Rolled back</th><th>Last event</th></tr>";
  const body = s.writers.map((w) => `<tr><td>${esc(w.writer)}</td><td>${w.notes}</td><td>${w.events.held_approved ?? 0}</td><td>${w.events.rejected ?? 0}</td><td>${w.events.rolled_back ?? 0}</td><td>${esc(w.last_event.slice(0, 16).replace("T", " "))}</td></tr>`).join("");
  return `<p>${s.notes} notes in the store, ${s.held_now} write(s) held right now.</p><table>${head}${body}</table>`;
}

function drillBlock(d: DrillFacts | null): string {
  if (!d) return "<p>The attack replay was not run (no store to copy).</p>";
  return `<p>${d.attacks} known attacks replayed on a copy of the store: ${d.held} held, ${d.blocked} blocked, ${d.warned} warned, <b>${d.reached} reached memory</b>.${d.known_misses.length ? ` Known misses: ${d.known_misses.map(esc).join("; ")}.` : ""}</p>`;
}

export function renderTrustReport(i: TrustInput): string {
  const t = i.bench.summary;
  const suiteRows = SUITES.map((s) => {
    const x = i.bench.suites[s];
    return `<tr><td>${esc(SUITE_NAMES[s])}</td><td>${x.scenarios}</td><td>${x.pass}</td><td>${x.fail + x.gap_closed}</td><td>${x.known_gap}</td></tr>`;
  }).join("");
  const keys = SUITES.map((s) => `<h3>${esc(SUITE_NAMES[s])}</h3>${list(headline(s, i.bench.suites[s].metrics))}`).join("");
  const gaps = i.bench.known_gaps.map((g) => `${g.id}: ${g.title} (${g.status}${g.fixed_in ? `, fixed in ${g.fixed_in}` : ""})`);
  const tests = i.testFiles === null ? "The test files are not part of the npm package, so their count is not shown here." : `${i.testFiles} test files in this source checkout.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monomem trust report</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;background:#fff;color:#161b29}
h1{font-size:1.5rem;margin-bottom:.2rem} h2{margin-top:2rem;border-bottom:1px solid #d9deea;padding-bottom:.2rem} h3{font-size:1rem;margin:1rem 0 .2rem}
.meta{color:#505b78;font-size:.85rem} table{border-collapse:collapse;width:100%} td,th{padding:.35rem .6rem;border-bottom:1px solid #d9deea;text-align:right}
td:first-child,th:first-child{text-align:left} .ok{color:#0f7a5c;font-weight:700} .bad{color:#c4263a;font-weight:700} .box{border:1px solid #d9deea;border-radius:8px;padding:.6rem 1rem;background:#f6f8fc}
@media (prefers-color-scheme:dark){body{background:#0c0f16;color:#e8ecf5}td,th,h2,.box{border-color:#232a3b}.box{background:#131827}.meta{color:#93a0bd}.ok{color:#35d0a5}.bad{color:#ff5d6c}}
</style></head><body><main>
<h1>Monomem trust report</h1>
<div class="meta">Monomem ${esc(i.version)} &middot; made ${esc(i.date)} &middot; Node ${esc(i.node)} on ${esc(i.platform)}</div>
<p class="box"><b>Not independently reviewed.</b> Every number below was computed when this file was made, on this computer. Nothing was typed in by hand. No note text and no key is in this file.</p>
<h2>Provenance benchmark</h2>
<p class="${i.bench.ok ? "ok" : "bad"}">${i.bench.ok ? "No scenario failed." : "Some scenarios failed."} ${t.pass} passed, ${t.fail + t.gap_closed} failed, ${t.known_gap} known gaps, ${t.skipped} skipped (${t.scenarios} scenarios, ${t.checks} checks, seed ${i.bench.seed}).</p>
<table><tr><th>Suite</th><th>Scenarios</th><th>Pass</th><th>Fail</th><th>Known gap</th></tr>${suiteRows}</table>
${keys}
<p class="meta">${esc(tests)}</p>
<h2>Attack replay</h2>
${drillBlock(i.drill)}
<h2>Who wrote what, and what happened to it</h2>
${writersTable(i.store)}
<h2>Known gaps (open and closed)</h2>
${list(gaps)}
<h2>What it does not do</h2>
<h3>From the README</h3>${list(i.readmeLimits)}
<h3>From the benchmark</h3>${list(i.bench.limits)}
<p class="meta">Re-make this file with <code>monomem report --out report.html</code>.</p>
</main></body></html>
`;
}
