// One-off: register the adaptive-r2 attack set in src/attack-sets/index.ts and test/attack-sets.test.ts (idempotent).
import { readFileSync, writeFileSync } from "node:fs";
let i = readFileSync("src/attack-sets/index.ts", "utf8");
if (!i.includes("ADAPTIVE_R2")) {
  i = i.replace(`import { ADAPTIVE } from "./data-adaptive-2026-11.js";`, `import { ADAPTIVE } from "./data-adaptive-2026-11.js";\nimport { ADAPTIVE_R2 } from "./data-adaptive-r2-2026-11.js";`);
  i = i.replace(`export const ATTACK_SETS`, `const fromAdaptiveR2 = (): AttackSample[] =>
  ADAPTIVE_R2.map(([id, , field, , text]) => ({
    id,
    title: field === "title" ? text : "Team note",
    text: field === "body" ? text : "Notes for the team.",
    source: field === "source" ? text : "team wiki",
    tags: field === "tags" ? [text.slice(0, 80)] : field === "fact" ? [\`fact:team_practice=\${text.slice(0, 80)}\`] : [],
  }));

export const ATTACK_SETS`);
  i = i.replace(`  {
    name: "garak-probes",`, `  {
    name: "adaptive-r2",
    title: \`Round 2 winning evasions of an adaptive LLM attacker, written after the claim-style rules (\${ADAPTIVE_R2.length})\`,
    source: "Monomem adaptive-attacker round 2, 2026-11-24: a fresh seeded qwen2.5:7b run against the linter with claim-style rules (scripts/adaptive-attacker-r2.mjs)",
    licence: "MIT",
    what: "Texts a feedback-driven (or blind) LLM attacker got stored with no warning in the title, body, tags, source or a fact value, for the same 12 hostile goals (.invalid addresses only), AFTER the claim-style rules existed. They were not used to design any rule. They reach today by construction, so this set shows whether a later change closes them.",
    samples: async () => fromAdaptiveR2(),
  },
  {
    name: "garak-probes",`);
  writeFileSync("src/attack-sets/index.ts", i);
}
let t = readFileSync("test/attack-sets.test.ts", "utf8");
if (!t.includes("adaptive-r2")) { t = t.replace("adaptive: 98,", 'adaptive: 98, "adaptive-r2": 80,'); writeFileSync("test/attack-sets.test.ts", t); }
