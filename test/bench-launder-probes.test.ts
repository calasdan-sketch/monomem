// 1.4.0 bench probes: E21 (self-launder-promote) and E22 (launder via memory) pass on Monomem over the real REST surface.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { defaultScenarioDir } from "../src/bench/index.js";
import { loadKnownGaps, loadScenarios, runScenario } from "../src/bench/engine.js";
import { MonomemAdapter } from "../src/bench/monomem-adapter.js";

const DIR = defaultScenarioDir();
const gaps = loadKnownGaps(DIR);

describe("bench suite E: laundering outside content", () => {
  for (const id of ["E21", "E22"]) {
    test(`${id} passes: marked, pin refused, poison_reach 0 at session start`, async () => {
      const s = loadScenarios(DIR, gaps).find((x) => x.id === id);
      assert.ok(s, `${id} exists`);
      const a = new MonomemAdapter();
      try {
        const r = await runScenario(a, s!, gaps, { seed: 1 });
        assert.equal(r.status, "pass", JSON.stringify(r.checks.filter((c) => !c.pass), null, 2) + (r.error ?? ""));
        assert.ok(r.checks.some((c) => c.metric === "poison_reach"));
      } finally {
        await a.close();
      }
    });
  }
});
