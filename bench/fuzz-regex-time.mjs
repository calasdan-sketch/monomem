// Opt-in measurement: time of each pure text function against adversarial inputs, 1 KB .. 1 MB. `npm run build` first.
// Prints the worst ms-per-KB at each size and flags super-linear growth (time(8n)/time(n) > 20; linear is 8).
// Use only throwaway homes: MONOMEM_HOME, ONEMEMORY_HOME and MONOMEM_AUDIT_LOG are set below if you did not.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const t = mkdtempSync(join(tmpdir(), "fuzz-regex-"));
process.env.MONOMEM_HOME ??= t; process.env.ONEMEMORY_HOME ??= t; process.env.MONOMEM_AUDIT_LOG ??= join(t, "audit.log");
const { ADVERSARIAL, timeMs } = await import("../dist/test/fuzz-text-inputs.js");
const { FUNCTIONS } = await import("../dist/test/fuzz-targets.js");
const sizes = (process.env.SIZES ?? "1024,8192,65536,524288,1048576").split(",").map(Number);
const rows = [];
for (const [fname, fn] of Object.entries(FUNCTIONS)) {
  for (const [iname, gen] of Object.entries(ADVERSARIAL)) {
    const times = [];
    for (const n of sizes) { const s = gen(n); fn(s); times.push(timeMs(() => fn(s))); }
    const worstRatio = Math.max(...times.slice(1).map((x, i) => x / Math.max(times[i], 0.05) / (sizes[i + 1] / sizes[i]) * 8));
    rows.push({ fname, iname, times, worstRatio });
  }
}
rows.sort((a, b) => b.times.at(-1) - a.times.at(-1));
for (const r of rows.slice(0, 25)) console.log(r.fname.padEnd(18), r.iname.padEnd(18), r.times.map((x) => x.toFixed(1).padStart(9)).join(" "), "ratio8x", r.worstRatio.toFixed(1));
const bad = rows.filter((r) => r.worstRatio > 20 && r.times.at(-1) > 50);
console.log(bad.length ? `SUPER-LINEAR: ${bad.map((r) => `${r.fname}/${r.iname}`).join(", ")}` : "no super-linear growth found");
