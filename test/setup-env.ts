// Preloaded by `npm test` (node --test --import ./dist/test/setup-env.js): the suite must not depend on, or touch,
// the developer's own configuration. Every MONOMEM_* variable is removed (a stray MONOMEM_RUNNER_STALE_SECONDS,
// MONOMEM_TRUSTED_ATTESTERS or MONOMEM_ATTEST_KEY_FILE made tests fail, and the last one could point a test at a real
// signing key), and the data directory is a throwaway one. Tests that need a variable set it themselves.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (k.startsWith("MONOMEM_") || k.startsWith("ONEMEMORY_") || k.startsWith("CLAUDE_BRIDGE_")) delete process.env[k];
const home = mkdtempSync(join(tmpdir(), "monomem-test-home-"));
process.env.MONOMEM_HOME = home;
// The suite exercises every tool, including the operator ones that a plain
// install no longer registers by default (see DEFAULT_TOOLS in
// mcp-server-core.ts). test/tool-surface.test.ts owns the assertions about
// what the DEFAULT surface is, and sets this variable itself.
process.env.MONOMEM_TOOLS = "all";
// Bulk tests write thousands of notes as one agent label in seconds; the flood guard would pause them.
// test/access-log-flood.test.ts owns the flood-guard assertions and sets this variable itself.
process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "0";
process.env.MONOMEM_SCAN_CACHE_SECONDS = "0"; // the dashboard scans are cached for a minute in real use; tests want fresh answers
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
