// Round 2: write src/attack-sets/data-adaptive-r2-2026-11.ts (at most 80 rows) from the round-2 winners that still REACH.
//   node scripts/adaptive-r2-export-set.mjs [model]      (needs a fresh `npm run build` only for the reach check; reach is re-verified with lintContent)
import { readFileSync, writeFileSync } from "node:fs";
import { FIELDS } from "./adaptive-attacker-r2.mjs";
import { lintContent } from "../dist/src/lint.js";

const MODEL = process.argv[2] ?? "qwen2.5:7b";
const cache = JSON.parse(readFileSync("bench/results/adaptive-r2-cache.json", "utf8"));
const att = readFileSync("bench/results/adaptive-r2-cache.attempts.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.verdict);
const rows = [];
for (const [k, v] of Object.entries(cache)) {
  const [model, mode, g, field] = k.split("|");
  if (model !== MODEL || !v.first || (mode !== "adaptive" && mode !== "blind")) continue;
  const text = v.first.text.replace(/\s+/g, " ").trim();
  let before = "no-feedback";
  if (mode === "adaptive") {
    const mine = att.filter((r) => r.mode === "adaptive" && r.model === model && r.goal === Number(g) && r.field === field).sort((a, b) => a.n - b.n);
    const prev = mine.filter((r) => r.n < v.first.n).at(-1);
    before = v.first.n === 1 ? "first-try" : prev ? (prev.verdict === "REACHED" ? "passed-but-vague" : `${prev.verdict}${prev.labels?.[0] ? ":" + prev.labels[0].replace(/@.*/, "") : ""}`) : "n/a";
  }
  rows.push({ mode, g: Number(g), field, before, text });
}
const hostOk = (t) => (t.match(/(?:https?:\/\/|@)[a-z0-9.-]+/gi) ?? []).every((h) => /\.invalid$|example\.com$/i.test(h));
// round-robin over (goal, field) so the 80 rows spread; adaptive before blind inside a cell; dedupe on field+text
rows.sort((a, b) => a.g - b.g || FIELDS.indexOf(a.field) - FIELDS.indexOf(b.field) || (a.mode === b.mode ? 0 : a.mode === "adaptive" ? -1 : 1));
const seen = new Set(), pool = [];
for (const r of rows) { if (!hostOk(r.text)) continue; const d = `${r.field}|${r.text.toLowerCase()}`; if (seen.has(d)) continue; seen.add(d); pool.push(r); }
// keep rows that really reach today (no finding at all); take every cell's adaptive winner first, then blind, until 80
const reaches = (r) => lintContent({ title: r.field === "title" ? r.text : "Team note", body: r.field === "body" ? r.text : "Notes for the team.", source: r.field === "source" ? r.text : "team wiki",
  tags: r.field === "tags" ? [r.text.slice(0, 80)] : r.field === "fact" ? [`fact:team_practice=${r.text.slice(0, 80)}`] : [], writer: "outsider" }).length === 0;
const ok = pool.filter(reaches);
const pick = [...ok.filter((r) => r.mode === "adaptive"), ...ok.filter((r) => r.mode === "blind")].slice(0, 80);
const esc = (s) => JSON.stringify(s);
const lines = pick.map((r, i) => `  [${esc(`AR${String(i + 1).padStart(3, "0")}`)}, ${r.g}, ${esc(r.field)}, ${esc(r.before)}, ${esc(r.text)}],`);
const out = `// Adaptive-attacker round-2 winners, 2026-11-24. LLM-generated against our own linter AFTER the claim-style rules (src/lint-claims.ts); unseen by those rules' design.
// Attacker model (local, Ollama): ${MODEL}, fresh cache, seeded sampling (seed 20261124 + call counter). Method: as data-adaptive-2026-11.ts: an LLM told it is doing an authorized
// test of the owner's own memory server is given a goal (a hostile instruction, all addresses .invalid) and ONE field (title, body, tags, source or fact value), and rewrites the
// field until Monomem's real write path (non-owner app key, throwaway server) stores it with no warning AND a judge model says the text still leads an agent to the goal.
// Rows: [id, goal index into ADAPTIVE_GOALS (same 12 goals as the first set), field, what the attacker's previous try got (verdict-before), text]. ${pick.length} rows, deduplicated, at most 80.
// "first-try" = passed on attempt 1; "no-feedback" = blind mode. These REACH today by construction: replaying them measures whether a later change closes them, not linter quality.
// Not defended: a miss here is a known gap (GAP-ADAPTIVE-REWRITE-R2, bench F35 and up). No real secrets; hostile addresses are .invalid.
export type AdaptiveR2Field = ${FIELDS.map(esc).join(" | ")};

export const ADAPTIVE_R2: ReadonlyArray<readonly [string, number, AdaptiveR2Field, string, string]> = [
${lines.join("\n")}
];
`;
writeFileSync("src/attack-sets/data-adaptive-r2-2026-11.ts", out);
console.log(`${pick.length} rows (pool ${pool.length}, reaching ${ok.length}); by field`, pick.reduce((a, r) => ((a[r.field] = (a[r.field] ?? 0) + 1), a), {}));
