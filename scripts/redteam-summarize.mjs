// Summarise replay results and pick the small committed sample set.
// usage: node scripts/redteam-summarize.mjs <workdir> [--emit-ts <file>]   workdir holds garak.jsonl pyrit.jsonl + *-out.jsonl
// Sample rule (fixed, not tuned): families that had >=1 REACHED (agent writer), ordered by REACHED count desc then name;
// from each take the first 3 REACHED payloads in file order whose text is <= 500 chars (garak) / <= 700 (pyrit); 75 from garak then 75 from pyrit (150 max).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const emit = process.argv.indexOf("--emit-ts") > 0 ? process.argv[process.argv.indexOf("--emit-ts") + 1] : null;
const rd = (f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sets = { garak: ["garak.jsonl", "garak-out.jsonl"], pyrit: ["pyrit.jsonl", "pyrit-out.jsonl"] };
const fam = (tool, f) => (tool === "garak" ? f : f);
// Excluded from the committed sample (a safety filter, applied before picking): harmful-content wording, and any URL host other than .invalid / example.com.
const UNSAFE = /bomb|kill|suicid|slur|hate|rape|nazi|child|drug|meth|weapon|malware|virus|explosive|poison|racis|toxic|sex/i;
const badUrl = (t) => (t.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).some((u) => !/^https?:\/\/([^/]*\.)?(invalid|example\.com)(\/|$|:)/.test(u));
const out = {};
const picks = [];
for (const [tool, [pf, of]] of Object.entries(sets)) {
  const text = Object.fromEntries(rd(pf).map((x) => [x.id, x.text]));
  const rows = rd(of);
  for (const who of ["agent", "owner"]) {
    const t = {};
    for (const r of rows.filter((x) => x.who === who)) {
      const k = fam(tool, r.family);
      (t[k] ??= { held: 0, blocked: 0, warned: 0, reached: 0 })[r.verdict]++;
    }
    out[`${tool}/${who}`] = t;
  }
  const agent = rows.filter((x) => x.who === "agent");
  const fams = {};
  for (const r of agent) if (r.verdict === "reached") (fams[r.family] ??= []).push(r.id);
  const max = tool === "garak" ? 500 : 700;
  const order = Object.keys(fams).filter((f) => !UNSAFE.test(f)).sort((a, b) => fams[b].length - fams[a].length || a.localeCompare(b));
  for (const f of order) for (const id of fams[f].filter((i) => text[i].length <= max && !UNSAFE.test(text[i]) && !badUrl(text[i])).slice(0, 3)) picks.push({ id, tool, family: f, text: text[id] });
}
const summary = {};
for (const [k, t] of Object.entries(out)) {
  const tot = { held: 0, blocked: 0, warned: 0, reached: 0 };
  for (const v of Object.values(t)) for (const x of Object.keys(tot)) tot[x] += v[x];
  summary[k] = tot;
}
console.log(JSON.stringify(summary));
if (!emit) console.log(JSON.stringify(out, null, 1));
const chosen = [...picks.filter((p) => p.tool === "garak").slice(0, 75), ...picks.filter((p) => p.tool === "pyrit").slice(0, 75)];
console.log("picked", chosen.length, "of", picks.length);
if (emit) {
  // Text is stored as JSON string literals with every non-printable-ASCII char escaped, so the file holds no hidden characters.
  const esc = (s) => JSON.stringify(s).replace(/[^\x20-\x7e]/g, (c) => { const cp = c.codePointAt(0); return cp > 0xffff ? "\\u{" + cp.toString(16) + "}" : "\\u" + cp.toString(16).padStart(4, "0"); });
  const lines = chosen.map((p, i) => `  [${esc(`${p.tool}-${p.family.replace(/[^A-Za-z0-9.]/g, "")}-${i}`)}, ${esc(p.text)}],`);
  writeFileSync(emit, lines.join("\n") + "\n");
}
