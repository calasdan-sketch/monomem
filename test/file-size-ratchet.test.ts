// Phase 0 split the four largest files so parallel work stops colliding in them. This keeps them from growing back:
// new logic goes into its own file (src/mcp/tools-*.ts, src/api/routes-*.ts, src/doctor/*.ts, src/cli/*.ts,
// src/store/*.ts). A limit may only go DOWN; raising one needs a reason in the commit that does it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Line count after the split, plus a small margin for one-line fixes. */
const MAX_LINES: Record<string, number> = {
  "src/store.ts": 8300, // 8,250 after the split
  "src/cli.ts": 2760, // 2,728
  "src/api.ts": 370, // 353
  "src/mcp-server-core.ts": 80, // 72
};

test("the split files do not grow back past their post-split size", () => {
  const root = join(import.meta.dirname, "..", "..");
  const over: string[] = [];
  for (const [f, max] of Object.entries(MAX_LINES)) {
    const lines = readFileSync(join(root, f), "utf8").split("\n").length - 1;
    if (lines > max) over.push(`${f} has ${lines} lines (limit ${max}): put the new code in its own file`);
  }
  assert.deepEqual(over, []);
});
