// Model-based random test (see fuzz-model-lib.ts). CI runs a few seeds; MONOMEM_FUZZ_SEEDS=200 MONOMEM_FUZZ_OPS=200 is the big sweep
// (about 70 s), MONOMEM_FUZZ_MCP_SEEDS / MONOMEM_FUZZ_MCP_OPS drive the MCP-server variant, MONOMEM_FUZZ_FIRST the first seed.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { genOps, runOps, shrink, storeDriver, mcpDriver, rng, type Driver } from "./fuzz-model-lib.js";

process.env.MONOMEM_HISTORY_VERSIONS = "500";
const num = (name: string, dflt: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== undefined ? n : dflt;
};
const SEEDS = num("MONOMEM_FUZZ_SEEDS", 6);
const OPS = num("MONOMEM_FUZZ_OPS", 80);
const FIRST = num("MONOMEM_FUZZ_FIRST", 1);
const MCP_SEEDS = num("MONOMEM_FUZZ_MCP_SEEDS", 1);
const MCP_OPS = num("MONOMEM_FUZZ_MCP_OPS", 30);
const NL = "\n";

const makeFor = (seed: number) => async (): Promise<{ d: Driver; gated: string[] }> => ({ d: storeDriver(new Store(":memory:")), gated: rng(seed)() < 0.5 ? ["gated"] : [] });

test(`model vs Store: ${SEEDS} seeds x ${OPS} ops`, async () => {
  const failed: string[] = [];
  for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
    const ops = genOps(seed, OPS, false);
    const why = await runOps(makeFor(seed), ops);
    if (why) {
      const min = await shrink(makeFor(seed), ops);
      failed.push(`seed ${seed}: ${why}${NL}  minimal (${min.length} ops): ${JSON.stringify(min)}${NL}  after shrink: ${await runOps(makeFor(seed), min, 1)}`);
    }
  }
  assert.deepEqual(failed, [], failed.join(NL));
});

test(`model vs the real MCP stdio server (two apps): ${MCP_SEEDS} seeds x ${MCP_OPS} ops`, async () => {
  const failed: string[] = [];
  for (let seed = FIRST; seed < FIRST + MCP_SEEDS; seed++) {
    const make = async (): Promise<{ d: Driver; gated: string[] }> => ({ d: await mcpDriver(mkdtempSync(join(tmpdir(), "fuzz-mcp-"))), gated: [] });
    const ops = genOps(seed, MCP_OPS, true);
    const why = await runOps(make, ops, 5);
    if (why) failed.push(`seed ${seed}: ${why}${NL}  ops: ${JSON.stringify(await shrink(make, ops, 25))}`);
  }
  assert.deepEqual(failed, [], failed.join(NL));
});
