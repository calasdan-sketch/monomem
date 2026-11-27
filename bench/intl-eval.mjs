// Multilingual attack set (bench/intl-attacks.json) through lintContent as an outside writer. `npm run build` first.
// held = an injection finding (quarantined by default); warned = a directive finding only; reach = neither.
// Usage: node bench/intl-eval.mjs [path-to-dist/src/lint.js]   (default: this checkout's build)
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const t = mkdtempSync(join(tmpdir(), "intl-eval-"));
process.env.MONOMEM_HOME = join(t, "m"); process.env.ONEMEMORY_HOME = join(t, "o"); process.env.MONOMEM_AUDIT_LOG = join(t, "audit.log");
const lintPath = process.argv[2] ?? new URL("../dist/src/lint.js", import.meta.url).href;
const { lintContent } = await import(lintPath.startsWith("file:") ? lintPath : pathToFileURL(lintPath).href);
const set = JSON.parse(readFileSync(new URL("./intl-attacks.json", import.meta.url), "utf8"));
const verdict = (body) => {
  const f = lintContent({ body, writer: "token:outsider" });
  return f.some((x) => x.category === "injection") ? "held" : f.some((x) => x.category === "directive") ? "warned" : "reach";
};
const out = { tuned: {}, fresh: {}, holdout: {}, benign: {}, benign2: {} };
const misses = [];
for (const kind of ["tuned", "fresh", "holdout"]) for (const [lang, goals] of Object.entries(set[kind])) {
  const row = (out[kind][lang] = { held: 0, warned: 0, reach: 0 });
  for (const [goal, text] of Object.entries(goals)) { const v = verdict(text); row[v]++; if (v === "reach") misses.push(`${kind}/${lang}/${goal}`); }
}
const fps = [];
for (const kind of ["benign", "benign2"]) for (const [lang, texts] of Object.entries(set[kind])) {
  const row = (out[kind][lang] = { held: 0, warned: 0, reach: 0 });
  for (const text of texts) { const v = verdict(text); row[v]++; if (v !== "reach") fps.push(`${kind}/${lang}: ${v}: ${text.slice(0, 60)}`); }
}
const sum = (o) => Object.values(o).reduce((a, r) => ({ held: a.held + r.held, warned: a.warned + r.warned, reach: a.reach + r.reach }), { held: 0, warned: 0, reach: 0 });
for (const kind of ["tuned", "fresh", "holdout", "benign", "benign2"]) {
  console.log(`\n${kind}: ${JSON.stringify(sum(out[kind]))}`);
  for (const [lang, r] of Object.entries(out[kind])) console.log(`  ${lang}  held ${r.held}  warned ${r.warned}  reach ${r.reach}`);
}
console.log("\nreach:", misses.join(", ") || "none");
console.log("benign flagged:", fps.length ? "\n  " + fps.join("\n  ") : "none");
