// False holds on real chat sessions (LongMemEval-S cleaned + LoCoMo, ~/.cache/monomem-bench/), as an OUTSIDE writer (the strictest case:
// claim rules only run for writers that are not the owner). Compares two builds. `npm run build` first.
// Usage: node bench/intl-fp.mjs <old dist/src dir> <new dist/src dir>
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const t = mkdtempSync(join(tmpdir(), "intl-fp-"));
process.env.MONOMEM_HOME = join(t, "m"); process.env.ONEMEMORY_HOME = join(t, "o"); process.env.MONOMEM_AUDIT_LOG = join(t, "audit.log");
const [oldDir, newDir] = process.argv.slice(2).map((d) => pathToFileURL(d.endsWith("/") ? d : d + "/").href);
const R = await import(new URL("bench/retrieval.js", newDir).href);
const A = await import(new URL("lint.js", oldDir).href), B = await import(new URL("lint.js", newDir).href);
const held = (lint, d) => lint.lintContent({ title: d.title, body: d.body, writer: "token:outsider" }).filter((f) => f.category === "injection").map((f) => f.label);
const c = join(homedir(), ".cache", "monomem-bench");
let n = 0, a = 0, b = 0, ms = 0;
const onlyNew = [], onlyOld = [];
for (const [f, fn] of [["longmemeval_s_cleaned.json", "longMemEvalHaystacks"], ["locomo10.json", "locomoHaystacks"]]) {
  const seen = new Set();
  for (const h of R[fn](JSON.parse(readFileSync(join(c, f), "utf8")), "session")) for (const d of h.docs) {
    if (seen.has(d.unit)) continue; seen.add(d.unit); n++;
    const x = held(A, d); const t0 = performance.now(); const y = held(B, d); ms += performance.now() - t0;
    if (x.length) a++; if (y.length) b++;
    if (y.length && !x.length && onlyNew.length < 10) onlyNew.push(`${y.join("|")}: ${(d.title + " " + d.body).slice(0, 160).replace(/\s+/g, " ")}`);
    if (x.length && !y.length && onlyOld.length < 10) onlyOld.push(`${x.join("|")}: ${(d.title + " " + d.body).slice(0, 160).replace(/\s+/g, " ")}`);
  }
}
console.log({ docs: n, oldHeld: a, newHeld: b, newMsPerDoc: +(ms / n).toFixed(3) });
console.log("held only by new:", onlyNew.length ? "\n  " + onlyNew.join("\n  ") : "none");
console.log("held only by old:", onlyOld.length ? "\n  " + onlyOld.join("\n  ") : "none");
