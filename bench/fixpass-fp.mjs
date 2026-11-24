// Benign false-positive diff for the fix pass (2026-11-23).
//   node bench/fixpass-fp.mjs save bench/results/fixpass-fp-baseline.json    record verdict per benign note (all corpora)
//   node bench/fixpass-fp.mjs diff bench/results/fixpass-fp-baseline.json    list notes whose verdict got worse, per corpus and rule label
// Corpora: LongMemEval-S and LoCoMo turns (if cached), repo CHANGELOG + docs, bench/dev-notes-fp.txt, bench/benign-corpus.txt,
// bench/fixpass-benign.txt (field-aware: title, body, tags, source). Writer is an app key ("token:bench-agent").
// Notes are keyed by sha1 of their fields, so edits to the docs after the baseline do not count as changes.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { lintContent } from "../dist/src/lint.js";
import { longMemEvalHaystacks, locomoHaystacks } from "../dist/src/bench/retrieval.js";

const CACHE = join(homedir(), ".cache", "monomem-bench");
const EXCLUDE = new Set(["memory-linter.md", "BENCHMARK.md", "SECURITY.md", "security-scorecard.md"]);
const WRITER = process.env.FP_WRITER ?? "token:bench-agent";

function chat(file, load) {
  const p = join(CACHE, file);
  if (!existsSync(p)) return [];
  const seen = new Set();
  const out = [];
  for (const h of load(JSON.parse(readFileSync(p, "utf8")), "turn"))
    for (const d of h.docs) {
      const k = `${d.unit}|${d.title}`;
      if (!seen.has(k)) { seen.add(k); out.push({ body: d.body }); }
    }
  return out;
}
function repoText() {
  const t = readFileSync("CHANGELOG.md", "utf8").split(/\n(?=- )/).filter((s) => s.startsWith("- "));
  for (const f of readdirSync("docs")) {
    if (!f.endsWith(".md") || EXCLUDE.has(f)) continue;
    t.push(...readFileSync(join("docs", f), "utf8").split(/\n\s*\n/).filter((s) => s.trim().length > 40 && !s.startsWith("```")));
  }
  return t.map((body) => ({ body }));
}
const paras = (f) => readFileSync(f, "utf8").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
function fixpass() {
  const out = [];
  for (const line of readFileSync("bench/fixpass-benign.txt", "utf8").split("\n")) {
    const m = /^([BTGS])\t(.+)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    out.push(k === "B" ? { body: v } : k === "T" ? { title: v, body: "Notes." } : k === "G" ? { body: "Notes.", tags: v.split(",") } : { body: "Notes.", source: v });
  }
  return out;
}
function corpora() {
  return {
    longmemeval: chat("longmemeval_s_cleaned.json", longMemEvalHaystacks),
    locomo: chat("locomo10.json", locomoHaystacks),
    repo_docs: repoText(),
    dev_notes: paras("bench/dev-notes-fp.txt").map((body) => ({ body })),
    benign_corpus: paras("bench/benign-corpus.txt").filter((t) => !/^#cat:/.test(t)).map((body) => ({ body })),
    fixpass_benign: fixpass(),
  };
}
const verdict = (f) => (f.some((x) => x.category === "secret") ? "refused" : f.some((x) => x.category === "injection") ? "held" : f.length ? "warned" : "ok");
const RANK = { ok: 0, warned: 1, held: 2, refused: 3 };
const key = (n) => createHash("sha1").update(JSON.stringify([n.title ?? "", n.body ?? "", n.tags ?? [], n.source ?? ""])).digest("hex").slice(0, 16);

function measure() {
  const res = {};
  for (const [name, notes] of Object.entries(corpora())) {
    const m = {};
    for (const n of notes) {
      const f = lintContent({ ...n, writer: WRITER });
      const v = verdict(f);
      if (v !== "ok") m[key(n)] = { v, labels: [...new Set(f.map((x) => `${x.category}:${x.label}@${x.field}`))], text: JSON.stringify(n).slice(0, 200) };
    }
    res[name] = { total: notes.length, flagged: m };
  }
  return res;
}
const [mode, file] = process.argv.slice(2);
const now = measure();
const count = (m, v) => Object.values(m).filter((x) => x.v === v).length;
if (mode === "save") {
  writeFileSync(file, JSON.stringify(now));
  for (const [n, r] of Object.entries(now)) console.log(n.padEnd(15), r.total, "held", count(r.flagged, "held"), "warned", count(r.flagged, "warned"), "refused", count(r.flagged, "refused"));
} else {
  const base = JSON.parse(readFileSync(file, "utf8"));
  for (const [n, r] of Object.entries(now)) {
    const b = base[n].flagged;
    const worse = Object.entries(r.flagged).filter(([k, x]) => RANK[x.v] > RANK[b[k]?.v ?? "ok"]);
    console.log(n.padEnd(15), `total ${r.total}  held ${count(b, "held")} -> ${count(r.flagged, "held")}  warned ${count(b, "warned")} -> ${count(r.flagged, "warned")}  refused ${count(b, "refused")} -> ${count(r.flagged, "refused")}  worse: ${worse.length}`);
    for (const [, x] of worse) console.log(`     ${x.v} ${x.labels.join(",")} :: ${x.text}`);
  }
}
