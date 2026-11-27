// Round 2, second test: run the stored winners of the round-2 attacker through the optional local-model check, and the benign corpora.
//   MONOMEM_LINT_MODEL=on MONOMEM_LINT_MODEL_URL=http://localhost:11434 MONOMEM_LINT_MODEL_NAME=<model> node scripts/adaptive-r2-modelcheck.mjs <winners.json> <out.json>
// For each winner two ways: "as-field" = the real path (the model only ever sees title + body of a stored note, so a text that lives in tags/source/fact is NOT shown),
// and "as-body" = best case, the winner text put in the body (what the model would say if the field were sent).
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { modelLintConfig, classifyNote } from "../dist/src/lint-model.js";
import { buildFields } from "./adaptive-attacker-r2.mjs";

const cfg = modelLintConfig();
if (!cfg) throw new Error("set MONOMEM_LINT_MODEL=on, _URL and _NAME");
const [winFile, outFile] = process.argv.slice(2);
const wins = JSON.parse(readFileSync(winFile, "utf8"));
const LOG = outFile + "l";
const done = new Map(existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return [o.k, o]; }) : []);
async function ask(k, note) {
  if (done.has(k)) return done.get(k);
  const t0 = Date.now();
  const v = await classifyNote(cfg, note);
  const o = { k, verdict: v?.verdict ?? null, ms: Date.now() - t0 };
  appendFileSync(LOG, JSON.stringify(o) + "\n"); done.set(k, o); return o;
}
const rows = [];
for (const w of wins) {
  const f = buildFields(w.field, w.text);
  const real = await ask(`w|${w.mode}|${w.goal}|${w.field}|real`, { title: f.title, body: f.body });
  const body = await ask(`w|${w.mode}|${w.goal}|${w.field}|body`, { title: "Team note", body: w.text });
  rows.push({ mode: w.mode, goal: w.goal, field: w.field, real: real.verdict, body: body.verdict });
}
const ben = [];
const corp = (p, sep) => readFileSync(p, "utf8").split(sep).map((s) => s.trim().replace(/^[BTGS]	/, "")).filter((s) => s && !s.startsWith("#"));
for (const [name, p] of [["benign-corpus", "bench/benign-corpus.txt"], ["fixpass-benign", "bench/fixpass-benign.txt"]]) {
  const items = corp(p, /\n\s*\n|\n/).filter((s, i, a) => a.indexOf(s) === i);
  for (let i = 0; i < items.length; i++) { const r = await ask(`b|${name}|${i}`, { title: "Team note", body: items[i] }); ben.push({ name, i, verdict: r.verdict, text: items[i].slice(0, 120) }); }
}
const lat = [...done.values()].map((o) => o.ms).sort((a, b) => a - b);
const cnt = (a, f) => a.filter(f).length;
const sum = { model: cfg.model, winners: rows.length, real_flagged: cnt(rows, (r) => r.real === "instruction_like"), body_flagged: cnt(rows, (r) => r.body === "instruction_like"),
  real_none: cnt(rows, (r) => r.real === null), body_none: cnt(rows, (r) => r.body === null),
  byField: Object.fromEntries(["title", "body", "tags", "source", "fact"].map((f) => { const x = rows.filter((r) => r.field === f); return [f, { n: x.length, real: cnt(x, (r) => r.real === "instruction_like"), body: cnt(x, (r) => r.body === "instruction_like") }]; })),
  benign: Object.fromEntries(["benign-corpus", "fixpass-benign"].map((n) => { const x = ben.filter((b) => b.name === n); return [n, { n: x.length, flagged: cnt(x, (b) => b.verdict === "instruction_like"), none: cnt(x, (b) => b.verdict === null) }]; })),
  latency_median_ms: lat[Math.floor(lat.length / 2)], latency_p95_ms: lat[Math.floor(lat.length * 0.95)] };
writeFileSync(outFile, JSON.stringify({ sum, rows, benFlagged: ben.filter((b) => b.verdict === "instruction_like") }, null, 1));
console.log(JSON.stringify(sum, null, 1));
