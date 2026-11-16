import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { recallHardTimeoutMs, RECALL_HARD_TIMEOUT_MS } from "../src/recall.js";

test("MONOMEM_RECALL_TIMEOUT_MS can only raise the 5 s session-start cap, to at most 60 s", () => {
  assert.equal(recallHardTimeoutMs({}), RECALL_HARD_TIMEOUT_MS);
  assert.equal(recallHardTimeoutMs({ MONOMEM_RECALL_TIMEOUT_MS: "100" }), RECALL_HARD_TIMEOUT_MS);
  assert.equal(recallHardTimeoutMs({ MONOMEM_RECALL_TIMEOUT_MS: "junk" }), RECALL_HARD_TIMEOUT_MS);
  assert.equal(recallHardTimeoutMs({ MONOMEM_RECALL_TIMEOUT_MS: "30000" }), 30_000);
  assert.equal(recallHardTimeoutMs({ MONOMEM_RECALL_TIMEOUT_MS: "999999" }), 60_000);
});
