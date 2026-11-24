// Fix-pass evaluation frame (2026-11-23). Builds the list of attack texts that REACH the write gate today and splits them
// by a fixed rule: sha256 of the JSON of the note fields [title, body, tags, source]; last hex digit even = TUNING, odd = HELD-OUT.
//   node bench/fixpass-frame.mjs build        writes bench/fixpass-split.json (keys, halves; no texts)
//   node bench/fixpass-frame.mjs tuning       prints the TUNING reachers (the only items rule design may read)
//   node bench/fixpass-frame.mjs score <half> counts per source for "tuning" or "heldout" (never prints text)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ATTACK_SETS } from "../dist/src/attack-sets/index.js";
import { lintContent } from "../dist/src/lint.js";

const SOURCE = { adaptive: "adaptive", "garak-probes": "garak", "pyrit-converted": "pyrit", "probes-context": "probes", "probes-encoding": "probes", "probes-toolstyle": "probes", "probes-stego": "probes" };
const WRITER = "outsider";

export const noteOf = (s) => ({ title: s.title ?? "Note", body: s.text, tags: s.tags ?? [], source: s.source });
const hits = (s) => lintContent({ ...noteOf(s), writer: WRITER }).filter((f) => f.category !== "pii");
export const halfOf = (s) => {
  const h = createHash("sha256").update(JSON.stringify([s.title ?? "Note", s.text, s.tags ?? [], s.source ?? null])).digest("hex");
  return parseInt(h.slice(-1), 16) % 2 === 0 ? "tuning" : "heldout";
};

async function allSamples() {
  const out = [];
  for (const set of ATTACK_SETS) {
    if (!SOURCE[set.name]) continue;
    for (const s of await set.samples()) out.push({ key: `${set.name}:${s.id}`, source: SOURCE[set.name], s });
  }
  const plain = JSON.parse(readFileSync("scripts/redteam-core-instructions.json", "utf8"));
  plain.forEach((t, i) => out.push({ key: `plain:P${String(i + 1).padStart(2, "0")}`, source: "plain-English", s: { id: `P${i + 1}`, text: t } }));
  return out;
}

const mode = process.argv[2];
const all = await allSamples();
const splitFile = "bench/fixpass-split.json";
if (mode === "build") {
  const rows = all.filter((x) => hits(x.s).length === 0).map((x) => ({ key: x.key, source: x.source, half: halfOf(x.s) }));
  const count = {};
  for (const r of rows) count[`${r.source}/${r.half}`] = (count[`${r.source}/${r.half}`] ?? 0) + 1;
  writeFileSync(splitFile, JSON.stringify({ rule: "half = parity of the last hex digit of sha256(JSON [title, body, tags, source]) of the note fields; even = tuning, odd = heldout. Items listed are those that REACHED (no lint finding except pii) for writer 'outsider' at baseline 928d468. Texts live in src/attack-sets and scripts/redteam-core-instructions.json.", baseline_commit: "928d468", count, items: rows }, null, 1));
  console.log(count, rows.length);
} else if (mode === "tuning") {
  const split = JSON.parse(readFileSync(splitFile, "utf8"));
  const tuning = new Set(split.items.filter((r) => r.half === "tuning").map((r) => r.key));
  for (const x of all) if (tuning.has(x.key)) console.log(JSON.stringify({ key: x.key, ...noteOf(x.s) }));
} else if (mode === "score") {
  const half = process.argv[3];
  const split = JSON.parse(readFileSync(splitFile, "utf8"));
  const want = new Set(split.items.filter((r) => r.half === half).map((r) => r.key));
  const per = {};
  let n = 0, c = 0;
  for (const x of all) if (want.has(x.key)) {
    const p = (per[x.source] ??= { n: 0, caught: 0 });
    p.n++; n++;
    if (hits(x.s).length) { p.caught++; c++; }
  }
  console.log(half, JSON.stringify(per), `total ${c}/${n}`);
}
