import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2], "utf8")); const byId = new Map(p.nodes.map((n) => [n.id, n]));
const mode = process.argv[4] ?? "fn";
const self = new Map(); const dt = p.timeDeltas; for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + dt[i]);
const agg = new Map(); for (const [id, t] of self) { const n = byId.get(id).callFrame; const k = mode === "file" ? n.url.split("/").slice(-3).join("/") || n.functionName : n.functionName + " " + n.url.split("/").slice(-2).join("/") + ":" + n.lineNumber; agg.set(k, (agg.get(k) ?? 0) + t); }
const tot = [...agg.values()].reduce((a, b) => a + b, 0); console.log("total ms", (tot / 1000).toFixed(0));
for (const [k, t] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, +(process.argv[3] ?? 20))) console.log((t / 1000).toFixed(1).padStart(8), k);
