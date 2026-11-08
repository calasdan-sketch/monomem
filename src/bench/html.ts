// `monomem bench --html out.html`: the benchmark as a one-page receipt you can keep or share. Static HTML: no scripts, no
// links, no pictures. Every number comes from the same report `monomem bench --json` prints.
import { SUITES } from "./types.js";
import { SUITE_NAMES, headline, type Report } from "./report.js";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderBenchHtml(r: Report, meta: { date: string; command?: string }): string {
  const t = r.summary;
  const rows = SUITES.map((s) => {
    const x = r.suites[s];
    return `<tr><td>${esc(SUITE_NAMES[s])}</td><td>${x.scenarios}</td><td>${x.pass}</td><td>${x.fail + x.gap_closed}</td><td>${x.known_gap}</td><td>${x.skipped}</td></tr>`;
  }).join("\n");
  const keys = SUITES.map((s) => `<h3>${esc(SUITE_NAMES[s])}</h3><ul>${headline(s, r.suites[s].metrics).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`).join("\n");
  const gaps = r.known_gaps.map((g) => `<li><b>${esc(g.id)}</b> ${esc(g.title)} (${esc(g.status)}${g.fixed_in ? `, fixed in ${esc(g.fixed_in)}` : ""})</li>`).join("");
  const cmd = meta.command ?? `monomem bench --seed ${r.seed}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Monomem benchmark receipt</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;background:#fff;color:#161b29}
h1{font-size:1.4rem;margin-bottom:.2rem} h3{margin:1rem 0 .2rem;font-size:1rem} .meta{color:#505b78;font-size:.85rem}
table{border-collapse:collapse;width:100%} td,th{padding:.35rem .6rem;border-bottom:1px solid #d9deea;text-align:right} td:first-child,th:first-child{text-align:left}
.ok{color:#0f7a5c;font-weight:700} .bad{color:#c4263a;font-weight:700} code{background:#eef1f8;padding:.1rem .3rem;border-radius:4px}
footer{margin-top:1.5rem;color:#505b78;font-size:.85rem}
@media (prefers-color-scheme:dark){body{background:#0c0f16;color:#e8ecf5}td,th{border-color:#232a3b}.meta,footer{color:#93a0bd}code{background:#1d2435}.ok{color:#35d0a5}.bad{color:#ff5d6c}}
</style></head><body>
<h1>Monomem benchmark receipt</h1>
<div class="meta">Monomem ${esc(r.version)} &middot; ${esc(meta.date)} &middot; Node ${esc(r.run.node)} on ${esc(r.run.platform)} &middot; adapter ${esc(r.adapter)} &middot; seed ${r.seed} &middot; ${r.run.elapsed_ms} ms</div>
<p class="${r.ok ? "ok" : "bad"}">${r.ok ? "All scenarios passed." : "Some scenarios failed."} ${t.pass} passed, ${t.fail + t.gap_closed} failed, ${t.known_gap} known gaps, ${t.skipped} skipped (${t.scenarios} scenarios, ${t.checks} checks, ${t.checks_failed} checks failed).</p>
<table><tr><th>Suite</th><th>Scenarios</th><th>Pass</th><th>Fail</th><th>Known gap</th><th>Skipped</th></tr>
${rows}
<tr><th>Total</th><th>${t.scenarios}</th><th>${t.pass}</th><th>${t.fail + t.gap_closed}</th><th>${t.known_gap}</th><th>${t.skipped}</th></tr></table>
<h2>Key numbers</h2>
${keys}
<h2>Known gaps</h2><ul>${gaps || "<li>none</li>"}</ul>
<h2>Reproduce</h2><p><code>${esc(cmd)}</code> &mdash; offline, no model, same result every run with the same seed.</p>
<footer><b>What this does not measure.</b> ${r.limits.map(esc).join(" ")} It is not a search-quality or retrieval benchmark, and it says nothing about other products.</footer>
</body></html>
`;
}
