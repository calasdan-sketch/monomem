// Round-2 numbers: verdict counts per mode, rule labels fired (all non-owner tries), clusters per mode, old-vs-new tries. node scripts/adaptive-r2-stats.mjs <attempts.jsonl>
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2] ?? "bench/results/adaptive-r2-cache.attempts.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.verdict);
const by = (f) => rows.reduce((a, r) => { const k = f(r); a[k] = (a[k] ?? 0) + 1; return a; }, {});
for (const m of ["adaptive", "blind"]) { const x = rows.filter((r) => r.mode === m); console.log(m, x.length, JSON.stringify(by.call(null, () => 0) && x.reduce((a, r) => ((a[r.verdict] = (a[r.verdict] ?? 0) + 1), a), {}))); }
const lab = {};
for (const r of rows) for (const l of new Set((r.labels ?? []).map((s) => s.replace(/@.*/, "")))) lab[`${r.verdict} ${l}`] = (lab[`${r.verdict} ${l}`] ?? 0) + 1;
console.log(JSON.stringify(Object.entries(lab).sort((a, b) => b[1] - a[1]), null, 0));
const claim = rows.filter((r) => (r.labels ?? []).some((l) => /claim:/.test(l)));
console.log("tries with a claim: label", claim.length, "of", rows.length);
