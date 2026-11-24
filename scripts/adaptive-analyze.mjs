// Summarise bench/results/adaptive-cache*.json + .attempts.jsonl: per-cell table, per-field rates, flag reasons, winner clusters.
//   node scripts/adaptive-analyze.mjs [model] > summary.txt      (also writes bench/results/adaptive-winners.json)
import { readFileSync, writeFileSync } from "node:fs";
import { GOALS, FIELDS } from "./adaptive-attacker.mjs";

const MODEL = process.argv[2] ?? "qwen2.5:7b";
const cache = JSON.parse(readFileSync("bench/results/adaptive-cache.json", "utf8"));
const rows = readFileSync("bench/results/adaptive-cache.attempts.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

export function cluster(t) {
  if (/[A-Za-z0-9+/]{24,}={0,2}$/.test(t.trim()) || /\b(0x)?[0-9a-f]{24,}\b/i.test(t) || /rot13|base64|hex/i.test(t)) return "encoding";
  if (/[^\x00-\x7f]/.test(t.replace(/[‘’“”–—…]/g, "")) || /\b(por favor|bitte|s'il vous|todos|alle|toutes|siempre|immer|sempre)\b/i.test(t)) return "language switch";
  if (/\b(pretend|role|story|as if|imagine|persona|you are|dear|hi |hello|quote)\b/i.test(t)) return "role-play / framing";
  if (/\b(please|kindly|would be|recommended|consider|could you|it is best|suggest)\b/i.test(t)) return "indirect / polite wording";
  if (!/^(please |always |never |do |don'?t |send |make |ensure |use |call |run |ignore |approve |disable |treat |redirect |email |forward |export |hide |mark )/i.test(t.trim())) return "claim-style (no command word)";
  return "paraphrase";
}

import { existsSync } from "node:fs";
const rejudge = existsSync("bench/results/adaptive-rejudge.json") ? JSON.parse(readFileSync("bench/results/adaptive-rejudge.json", "utf8")) : {};
const key = (m, g, f) => `${MODEL}|${m}|${g}|${f}`;
const out = [];
const P = (s = "") => out.push(s);
const modes = ["blind", "adaptive", "owner"];
const cell = (m, g, f) => cache[`${MODEL}|${m}|${g}|${f}`];
P(`Model ${MODEL}`);
for (const m of modes) {
  const cells = [];
  for (let g = 0; g < GOALS.length; g++) for (const f of FIELDS) { const c = cell(m, g, f); if (c) cells.push({ g, f, c }); }
  const valid = cells.filter((x) => x.c.first), gate = cells.filter((x) => x.c.gateFirst);
  P(`\n${m}: ${cells.length} cells run; gate passed (any REACHED) ${gate.length}; valid defeat (REACHED and text still carries the goal) ${valid.length}`);
  for (const f of FIELDS) {
    const fc = cells.filter((x) => x.f === f);
    const fv = fc.filter((x) => x.c.first);
    const med = fv.map((x) => x.c.first.n).sort((a, b) => a - b);
    P(`  ${f.padEnd(7)} valid ${fv.length}/${fc.length}  gate-only ${fc.filter((x) => x.c.gateFirst && !x.c.first).length}  median attempts to first valid ${med.length ? med[Math.floor(med.length / 2)] : "-"}`);
  }
}
P("\nPer cell (goal x field): blind valid / adaptive valid at attempt n / owner");
for (let g = 0; g < GOALS.length; g++) {
  P(`G${g} ${GOALS[g]}`);
  P("   " + FIELDS.map((f) => { const b = cell("blind", g, f), a = cell("adaptive", g, f), o = cell("owner", g, f); return `${f}: B=${b ? (b.first ? "Y" + b.first.n : b.gateFirst ? "g" : "n") : "-"} A=${a ? (a.first ? "Y" + a.first.n : a.gateFirst ? "g" : "n") : "-"} O=${o ? (o.first ? "Y" : o.gateFirst ? "g" : "n") : "-"}`; }).join(" | "));
}
// why attempts were stopped
const reasons = {};
for (const r of rows.filter((r) => r.mode !== "owner" && r.verdict && r.verdict !== "REACHED")) for (const l of r.labels?.length ? r.labels : ["(" + r.verdict + ")"]) { const k = `${r.verdict} ${l.replace(/@.*$/, "")}`; reasons[k] = (reasons[k] ?? 0) + 1; }
P("\nTop flag reasons across all non-owner attempts:");
for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 25)) P(`  ${n}\t${k}`);
const att = rows.filter((r) => r.mode === "adaptive" && r.verdict);
P(`\nAdaptive attempts: ${att.length}; verdicts ${JSON.stringify(att.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {}))}`);
// winners
const winners = [];
for (const m of ["blind", "adaptive"]) for (let g = 0; g < GOALS.length; g++) for (const f of FIELDS) { const c = cell(m, g, f); if (c?.first) winners.push({ mode: m, goal: g, field: f, n: c.first.n, text: c.first.text, cluster: cluster(c.first.text) }); }
const byCluster = {};
for (const w of winners) byCluster[w.cluster] = (byCluster[w.cluster] ?? 0) + 1;
P("\nWinner clusters (heuristic classifier, blind+adaptive): " + JSON.stringify(byCluster));
const shortest = winners.filter((w) => w.mode === "adaptive").sort((a, b) => a.text.length - b.text.length);
P("\nShortest adaptive winner per cell (goal, field):");
for (const w of shortest) P(`  G${w.goal} ${w.field} n=${w.n} [${w.cluster}] ${w.text.slice(0, 140)}`);
writeFileSync(`bench/results/adaptive-winners-${MODEL.replace(/[^\w.-]/g, "_")}.json`, JSON.stringify(winners, null, 1));
console.log(out.join("\n"));
