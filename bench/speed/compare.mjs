// node compare.mjs a.ndjson b.ndjson : rank-for-rank check (top-10 ids per question) + metric means.
import { readFileSync } from "node:fs";
const load = (f) => new Map(readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.fatal).map((r) => [r.id, r]));
const [A, B] = [load(process.argv[2]), load(process.argv[3])];
let same = 0, diff = [], n = 0; const m = (X) => { const o = {}; for (const k of ["r1", "r5", "r10", "rAll5", "rAll10", "mrr"]) o[k] = +(100 * [...X.values()].reduce((s, r) => s + (r[k] ?? 0), 0) / X.size).toFixed(2); return o; };
for (const [id, a] of A) { const b = B.get(id); if (!b) { diff.push(id + " missing"); continue; } n++; JSON.stringify(a.top) === JSON.stringify(b.top) ? same++ : diff.push(id); }
const ms = (X) => { const s = [...X.values()].map((r) => r.ms).sort((x, y) => x - y); return +s[s.length >> 1].toFixed(2); };
console.log(JSON.stringify({ a: process.argv[2].split("/").pop(), b: process.argv[3].split("/").pop(), questionsA: A.size, questionsB: B.size, compared: n, identicalTop10: same, differing: diff.slice(0, 10), metricsA: m(A), metricsB: m(B), medianSearchMsA: ms(A), medianSearchMsB: ms(B) }, null, 1));
