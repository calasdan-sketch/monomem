// Evaluation of the optional local-model second opinion (src/lint-model.ts) against a REAL local model.
//   MONOMEM_LINT_MODEL=on MONOMEM_LINT_MODEL_URL=http://localhost:11434 MONOMEM_LINT_MODEL_NAME=<model> node bench/lint-model-eval/run.mjs [--half a|b|all] [--out file.json]
// Corpora: (1) 40 hand-written paraphrased attacks (attacks-paraphrased.json; each is checked against today's pattern linter first,
// and any the linter already catches is dropped from the "linter misses it" count), (2) the published attack sets in src/attack-sets,
// (3) benign: bench/dev-notes-fp.txt paragraphs + benign-100.json. Items are split in two fixed halves by attackHalf (sha256 of the id):
// the prompt was tuned on half a only; half b is the reported result.
import { readFileSync, writeFileSync } from "node:fs";
import { modelLintConfig, classifyNote } from "../../dist/src/lint-model.js";
import { lintContent } from "../../dist/src/lint.js";
import { ATTACK_SETS, attackHalf } from "../../dist/src/attack-sets/index.js";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const halfSel = arg("--half", "all");
const out = arg("--out", "");
const cfg = modelLintConfig();
if (!cfg) throw new Error("set MONOMEM_LINT_MODEL=on, MONOMEM_LINT_MODEL_URL and MONOMEM_LINT_MODEL_NAME");

const hit = (t) => lintContent({ title: "note", body: t, writer: "stdio:claude" }).some((f) => f.category === "injection" || f.category === "secret" || f.action === "quarantine" || f.action === "block");

const items = [];
JSON.parse(readFileSync("bench/lint-model-eval/attacks-paraphrased.json", "utf8")).forEach((t, i) => items.push({ id: `para-${i + 1}`, kind: "para", text: t }));
for (const s of ATTACK_SETS) if (!s.download) for (const x of await s.samples()) items.push({ id: `${s.name}/${x.id}`, kind: `set:${s.name}`, text: x.text });
readFileSync("bench/dev-notes-fp.txt", "utf8").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean).forEach((t, i) => items.push({ id: `devfp-${i + 1}`, kind: "benign-devfp", text: t }));
JSON.parse(readFileSync("bench/lint-model-eval/benign-100.json", "utf8")).forEach((t, i) => items.push({ id: `benign-${i + 1}`, kind: "benign-100", text: t }));

const pick = items.filter((x) => halfSel === "all" || attackHalf(x.id) === halfSel);
const rows = [];
for (const x of pick) {
  x.lint = hit(x.text);
  const t0 = Date.now();
  const v = await classifyNote(cfg, { title: x.kind.startsWith("benign") ? "note" : "note", body: x.text });
  rows.push({ id: x.id, kind: x.kind, half: attackHalf(x.id), lint: x.lint, verdict: v?.verdict ?? null, reason: v?.reason ?? "", ms: Date.now() - t0 });
  if (rows.length % 25 === 0) process.stderr.write(`${rows.length}/${pick.length}\n`);
}
if (out) writeFileSync(out, JSON.stringify({ model: cfg.model, rows }, null, 2));

const isAttack = (r) => !r.kind.startsWith("benign");
const rate = (a, b) => (b ? `${a}/${b} = ${((100 * a) / b).toFixed(1)}%` : "n/a");
const summarize = (label, rs) => {
  const para = rs.filter((r) => r.kind === "para");
  const paraMiss = para.filter((r) => !r.lint);
  const sets = rs.filter((r) => r.kind.startsWith("set:"));
  const setMiss = sets.filter((r) => !r.lint);
  const ben = rs.filter((r) => !isAttack(r));
  const lat = rs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n== ${label} (model ${cfg.model}) ==`);
  console.log(`paraphrased attacks the linter misses: model flags ${rate(paraMiss.filter((r) => r.verdict === "instruction_like").length, paraMiss.length)}; no verdict ${paraMiss.filter((r) => r.verdict === null).length}`);
  console.log(`  (paraphrased attacks the linter already catches: ${para.length - paraMiss.length} of ${para.length})`);
  console.log(`published attack-set samples the linter misses: model flags ${rate(setMiss.filter((r) => r.verdict === "instruction_like").length, setMiss.length)} (of ${sets.length} samples)`);
  for (const k of [...new Set(sets.map((r) => r.kind))]) {
    const m = sets.filter((r) => r.kind === k && !r.lint);
    console.log(`    ${k}: linter misses ${m.length}, model flags ${m.filter((r) => r.verdict === "instruction_like").length}`);
  }
  console.log(`benign false positives: ${rate(ben.filter((r) => r.verdict === "instruction_like").length, ben.length)}; no verdict ${ben.filter((r) => r.verdict === null).length}`);
  for (const k of ["benign-devfp", "benign-100"]) {
    const b = ben.filter((r) => r.kind === k);
    console.log(`    ${k}: ${b.filter((r) => r.verdict === "instruction_like").length}/${b.length}`);
  }
  if (lat.length) console.log(`latency per note: median ${lat[Math.floor(lat.length / 2)]} ms, p95 ${lat[Math.floor(lat.length * 0.95)]} ms, mean ${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)} ms (n=${lat.length})`);
};
if (halfSel === "all") {
  summarize("half a (tuned on)", rows.filter((r) => r.half === "a"));
  summarize("half b (held out, reported)", rows.filter((r) => r.half === "b"));
} else summarize(`half ${halfSel}`, rows);
