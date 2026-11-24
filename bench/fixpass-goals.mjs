// Held-out catch per adaptive-attacker GOAL (counts only), for the claim rules. Reads the goal index from the data file's metadata.
//   node bench/fixpass-goals.mjs [--heldout]   (default: tuning half)
import { readFileSync } from "node:fs";
import { ADAPTIVE, ADAPTIVE_GOALS } from "../dist/src/attack-sets/data-adaptive-2026-11.js";
import { ATTACK_SETS } from "../dist/src/attack-sets/index.js";
import { scanClaims } from "../dist/src/lint-claims.js";

const half = process.argv.includes("--heldout") ? "heldout" : "tuning";
const split = JSON.parse(readFileSync("bench/fixpass-split.json", "utf8"));
const want = new Set(split.items.filter((r) => r.half === half && r.key.startsWith("adaptive:")).map((r) => r.key.slice(9)));
const goalOf = new Map(ADAPTIVE.map((r) => [r[0], r[1]]));
const set = ATTACK_SETS.find((s) => s.name === "adaptive");
const per = {};
for (const s of await set.samples()) {
  if (!want.has(s.id)) continue;
  const g = goalOf.get(s.id);
  const p = (per[g] ??= { n: 0, caught: 0, fams: {} });
  p.n++;
  const hits = scanClaims({ title: s.title ?? "Note", body: s.text, tags: s.tags ?? [], source: s.source, writer: "outsider" });
  if (hits.length) p.caught++;
  for (const f of new Set(hits.map((h) => h.family))) p.fams[f] = (p.fams[f] ?? 0) + 1;
}
for (const [g, p] of Object.entries(per)) console.log(`G${Number(g) + 1} ${ADAPTIVE_GOALS[g].slice(0, 60).padEnd(60)} ${p.caught}/${p.n} ${JSON.stringify(p.fams)}`);
