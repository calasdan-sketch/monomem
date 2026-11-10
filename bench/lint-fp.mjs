// How often does the write check flag ordinary text?
//
// Runs lintContent (the same function every write goes through) over three
// corpora of text that contains no attacks, and counts what it would refuse,
// hold, or only warn about. Run after `npm run build`, with no MONOMEM_TOKEN*
// set (a live token adds its own check):
//
//   node bench/lint-fp.mjs [--show-held]
//
// Corpora (none of them is real agent notes; see docs/BENCHMARK.md):
//   - LongMemEval-S cleaned and LoCoMo-10 (chat), one note per turn, from the
//     cache the retrieval benchmark uses (~/.cache/monomem-bench).
//   - This repo's CHANGELOG bullets and docs paragraphs, minus files that quote
//     attacks on purpose (memory-linter.md, BENCHMARK.md, SECURITY.md, evals/).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { lintContent } from "../dist/src/lint.js";
import { longMemEvalHaystacks, locomoHaystacks } from "../dist/src/bench/retrieval.js";

const SHOW = process.argv.includes("--show-held");
const CACHE = join(homedir(), ".cache", "monomem-bench");
const EXCLUDE = new Set(["memory-linter.md", "BENCHMARK.md", "SECURITY.md"]);

function chat(file, load) {
  const p = join(CACHE, file);
  if (!existsSync(p)) return null;
  const seen = new Set();
  const texts = [];
  for (const h of load(JSON.parse(readFileSync(p, "utf8")), "turn")) {
    for (const d of h.docs) {
      const k = `${d.unit}|${d.title}`; // LongMemEval repeats sessions across questions
      if (seen.has(k)) continue;
      seen.add(k);
      texts.push(d.body);
    }
  }
  return texts;
}

function repoText() {
  const texts = readFileSync("CHANGELOG.md", "utf8").split(/\n(?=- )/).filter((s) => s.startsWith("- "));
  for (const f of readdirSync("docs")) {
    if (!f.endsWith(".md") || EXCLUDE.has(f)) continue;
    texts.push(...readFileSync(join("docs", f), "utf8").split(/\n\s*\n/).filter((s) => s.trim().length > 40 && !s.startsWith("```")));
  }
  return texts;
}

function run(name, texts) {
  if (!texts) return console.log(`${name}: not in ${CACHE}, skipped`);
  const count = { refused: 0, held: 0, warned: 0 };
  const labels = {};
  for (const body of texts) {
    const f = lintContent({ body });
    const held = f.some((x) => x.category === "injection");
    const refused = f.some((x) => x.category === "secret");
    if (refused) count.refused++;
    else if (held) count.held++;
    else if (f.length) count.warned++;
    for (const x of f) labels[`${x.category}: ${x.label}`] = (labels[`${x.category}: ${x.label}`] ?? 0) + 1;
    if (SHOW && (held || refused)) console.log(`  [${f.map((x) => x.label).join(", ")}] ${body.replace(/\s+/g, " ").slice(0, 160)}`);
  }
  const n = texts.length;
  const pct = (k) => ((100 * k) / n).toFixed(3) + "%";
  console.log(`${name}: ${n} notes — refused ${count.refused} (${pct(count.refused)}), held ${count.held} (${pct(count.held)}), warned only ${count.warned} (${pct(count.warned)})`);
  for (const [l, k] of Object.entries(labels).sort((a, b) => b[1] - a[1])) console.log(`    ${k}\t${l}`);
}

if (Object.keys(process.env).some((k) => k.startsWith("MONOMEM_TOKEN") || k.startsWith("ONEMEMORY_TOKEN"))) {
  console.error("Unset MONOMEM_TOKEN* first: a live token adds a check ordinary notes never hit.");
  process.exit(2);
}
run("LongMemEval-S (chat turns)", chat("longmemeval_s_cleaned.json", longMemEvalHaystacks));
run("LoCoMo-10 (chat turns)", chat("locomo10.json", locomoHaystacks));
run("Monomem CHANGELOG + docs (technical prose)", repoText());
