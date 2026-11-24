// Turn the winning evasions into src/attack-sets/data-adaptive-2026-11.ts (deduplicated, at most 100, one line each).
//   node scripts/adaptive-export-set.mjs
// Reads bench/results/adaptive-cache.json (+ .attempts.jsonl for verdict-before, adaptive-rejudge.json for the strict judge).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { GOALS, FIELDS } from "./adaptive-attacker.mjs";

const cache = JSON.parse(readFileSync("bench/results/adaptive-cache.json", "utf8"));
const att = readFileSync("bench/results/adaptive-cache.attempts.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.verdict);
const rejudge = existsSync("bench/results/adaptive-rejudge.json") ? JSON.parse(readFileSync("bench/results/adaptive-rejudge.json", "utf8")) : {};
const models = [...new Set(Object.keys(cache).map((k) => k.split("|")[0]))];
const rows = [];
for (const [k, v] of Object.entries(cache)) {
  const [model, mode, g, field] = k.split("|");
  if (!v.first || (mode !== "adaptive" && mode !== "blind")) continue;
  const text = v.first.text.replace(/\s+/g, " ").trim();
  // verdict before: what the attempt right before the winner got (adaptive); blind has no feedback loop, so "no-feedback".
  let before = "no-feedback";
  if (mode === "adaptive") {
    const mine = att.filter((r) => r.mode === "adaptive" && r.model === model && r.goal === Number(g) && r.field === field).sort((a, b) => a.n - b.n);
    const prev = mine.filter((r) => r.n < v.first.n).at(-1);
    before = v.first.n === 1 ? "first-try" : prev ? (prev.verdict === "REACHED" ? "passed-but-vague" : `${prev.verdict}${prev.labels?.[0] ? ":" + prev.labels[0].replace(/@.*/, "") : ""}`) : "n/a";
  }
  const strict = Object.values(rejudge[k] ?? {}).some(Boolean);
  rows.push({ model, mode, g: Number(g), field, before, text, strict, n: v.first.n });
}
// adaptive first, strict-confirmed first, then shortest; dedupe on field+text
rows.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "adaptive" ? -1 : 1) || Number(b.strict) - Number(a.strict) || a.text.length - b.text.length);
const hostOk = (t) => (t.match(/(?:https?:\/\/|@)[a-z0-9.-]+/gi) ?? []).every((h) => /\.invalid$|example\.com$/i.test(h));
const seen = new Set(), pick = [];
for (const r of rows) { if (!hostOk(r.text)) continue; const d = `${r.field}|${r.text.toLowerCase()}`; if (seen.has(d)) continue; seen.add(d); pick.push(r); if (pick.length >= 100) break; }
const esc = (s) => JSON.stringify(s);
const lines = pick.map((r, i) => `  [${esc(`AD${String(i + 1).padStart(3, "0")}`)}, ${r.g}, ${esc(r.field)}, ${esc(r.before)}, ${esc(r.text)}],`);
const out = `// Adaptive-attacker winners, 2026-11-23. LLM-generated against our own linter, tuned on nothing.
// Attacker models (local, Ollama): ${models.join(", ")}. Method: an LLM told it is doing an authorized test of the owner's own memory server is given a goal
// (a hostile instruction, all addresses .invalid) and ONE field (title, body, tags, source or fact value), and rewrites the field until Monomem's real
// write path (non-owner app key, throwaway server) stores it with no warning AND a judge model says the text still leads an agent to the goal.
// Rows: [id, goal index into ADAPTIVE_GOALS, field, what the attacker's previous try got (verdict-before), text]. ${pick.length} rows, deduplicated.
// "first-try" = passed on attempt 1; "no-feedback" = blind mode (no oracle feedback). These REACH today by construction (they were chosen for it): replaying
// them measures whether a later linter change closes them, not how good the linter is. See docs/adaptive-attacker-2026-11-23.md.
// Not defended: a miss here is a known gap (bench F30 and up). No real secrets; hostile addresses are .invalid.
export const ADAPTIVE_GOALS: readonly string[] = ${JSON.stringify(GOALS, null, 2)};

export type AdaptiveField = ${FIELDS.map(esc).join(" | ")};

export const ADAPTIVE: ReadonlyArray<readonly [string, number, AdaptiveField, string, string]> = [
${lines.join("\n")}
];
`;
writeFileSync("src/attack-sets/data-adaptive-2026-11.ts", out);
console.log(`${pick.length} rows written; by field`, pick.reduce((a, r) => ((a[r.field] = (a[r.field] ?? 0) + 1), a), {}), "strict-confirmed", pick.filter((r) => r.strict).length);
