// Per-family evaluation of the claim rules (src/lint-claims.ts), fix pass 2026-11-23.
//   node bench/fixpass-eval.mjs                 TUNING half only: reachers caught per family and source, benign hits per family and corpus
//   node bench/fixpass-eval.mjs --heldout       HELD-OUT half: counts only, no text printed. Run once per rule set.
// A "benign hit" is a benign note some rule fires on (writer: app key). Benign corpora as in bench/fixpass-fp.mjs, minus the 190k chat turns.
import { readFileSync } from "node:fs";
import { ATTACK_SETS } from "../dist/src/attack-sets/index.js";
import { scanClaims } from "../dist/src/lint-claims.js";
import { lintContent } from "../dist/src/lint.js";
import { createHash } from "node:crypto";

const HELD = process.argv.includes("--heldout");
const SHOW = process.argv.includes("--show");
const SRC = { adaptive: "adaptive", "garak-probes": "garak", "pyrit-converted": "pyrit", "probes-context": "probes", "probes-encoding": "probes", "probes-toolstyle": "probes", "probes-stego": "probes" };
const split = JSON.parse(readFileSync("bench/fixpass-split.json", "utf8"));
const want = new Set(split.items.filter((r) => r.half === (HELD ? "heldout" : "tuning")).map((r) => r.key));
const noteOf = (s) => ({ title: s.title ?? "Note", body: s.text, tags: s.tags ?? [], source: s.source });

const attacks = [];
for (const set of ATTACK_SETS) if (SRC[set.name]) for (const s of await set.samples()) attacks.push({ key: `${set.name}:${s.id}`, source: SRC[set.name], note: noteOf(s) });
JSON.parse(readFileSync("scripts/redteam-core-instructions.json", "utf8")).forEach((t, i) => attacks.push({ key: `plain:P${String(i + 1).padStart(2, "0")}`, source: "plain-English", note: { title: "Note", body: t, tags: [] } }));

const caught = {}; // family -> source -> n
const anyCaught = {}; // source -> {n, caught, held}
for (const a of attacks.filter((x) => want.has(x.key))) {
  const hits = scanClaims({ ...a.note, writer: "outsider" });
  const t = (anyCaught[a.source] ??= { n: 0, claim: 0, claimHold: 0 });
  t.n++;
  if (hits.length) t.claim++;
  if (hits.some((h) => h.action === "hold")) t.claimHold++;
  for (const f of new Set(hits.map((h) => h.family))) ((caught[f] ??= {})[a.source] = (caught[f][a.source] ?? 0) + 1);
}
if (process.argv.includes("--miss") && !HELD) {
  for (const a of attacks.filter((x) => want.has(x.key) && /^(adaptive|plain)/.test(x.key) && !scanClaims({ ...x.note, writer: "outsider" }).length))
    console.log("  MISS", a.key.split(":")[1], JSON.stringify([a.note.body === "Notes for the team." ? "" : a.note.body, a.note.title === "Team note" ? "" : a.note.title, a.note.tags, a.note.source === "team wiki" ? "" : a.note.source]).slice(0, 170));
}
console.log(HELD ? "HELD-OUT" : "TUNING", "claim rules, reachers caught (writer outsider)");
for (const [f, per] of Object.entries(caught)) console.log("  ", f.padEnd(22), JSON.stringify(per));
for (const [s, t] of Object.entries(anyCaught)) console.log("   total", s.padEnd(14), `${t.claim}/${t.n} caught by a claim rule (${t.claimHold} held)`);

// benign
const paras = (f) => readFileSync(f, "utf8").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
const fix = [];
for (const line of readFileSync("bench/fixpass-benign.txt", "utf8").split("\n")) {
  const m = /^([BTGS])\t(.+)$/.exec(line);
  if (m) fix.push(m[1] === "B" ? { body: m[2] } : m[1] === "T" ? { title: m[2], body: "Notes." } : m[1] === "G" ? { body: "Notes.", tags: m[2].split(",") } : { body: "Notes.", source: m[2] });
}
const corp = { dev_notes: paras("bench/dev-notes-fp.txt").map((body) => ({ body })), benign_corpus: paras("bench/benign-corpus.txt").filter((t) => !/^#cat:/.test(t)).map((body) => ({ body })), fixpass_benign: fix };
const fp = {};
for (const [c, notes] of Object.entries(corp)) for (const n of notes) {
  const hits = scanClaims({ ...n, writer: "token:bench-agent" });
  for (const h of hits) {
    const k = `${h.family}/${h.action}`;
    ((fp[k] ??= {})[c] = (fp[k][c] ?? 0) + 1);
    if (SHOW) console.log(`   FP ${k} [${c}] ${JSON.stringify(n).slice(0, 150)}`);
  }
}
console.log("benign hits per family/action and corpus (budget: 0 held, <=3 warned per family):");
for (const [k, per] of Object.entries(fp)) console.log("  ", k.padEnd(32), JSON.stringify(per));
if (!Object.keys(fp).length) console.log("   none");
// owner exemption sanity
const own = attacks.filter((a) => scanClaims({ ...a.note, writer: "cli" }).length).length;
console.log("owner writer (cli) hits across all attacks (must be 0):", own);
void lintContent; void createHash;
