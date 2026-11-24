// Preloaded by `npm test` (node --test --import ./dist/test/setup-env.js): the suite must not depend on, or touch,
// the developer's own configuration. Every MONOMEM_* variable is removed (a stray MONOMEM_RUNNER_STALE_SECONDS,
// MONOMEM_TRUSTED_ATTESTERS or MONOMEM_ATTEST_KEY_FILE made tests fail, and the last one could point a test at a real
// signing key), and the data directory is a throwaway one. Tests that need a variable set it themselves.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MONOMEM_TEST_TIME_SCALE is the one variable kept: it is read only by the tests (see slow() below), never by src, and
// it must survive here so that the test runner passes it on to every test file's process.
for (const k of Object.keys(process.env)) {
  if (k === "MONOMEM_TEST_TIME_SCALE") continue;
  if (k.startsWith("MONOMEM_") || k.startsWith("ONEMEMORY_") || k.startsWith("CLAUDE_BRIDGE_")) delete process.env[k];
}
// Replacing a note: the SHIPPED default is that only a person confirms (MONOMEM_REPLACE_CONFIRM=person, 1.8.0). Most of the
// suite tests the replace mechanics (codes, undo, staleness) through write-scope callers, so it opts into the older "agent"
// mode here, openly. test/replace-person-confirm.test.ts turns this off and tests the real default.
process.env.MONOMEM_REPLACE_CONFIRM = "agent";
// Each test process gets its own temp root. Test files run in parallel processes, and a shared os.tmpdir() let one
// file count another's monomem-drill-* copies (r2-fixsec drill flake) and collected folders tests forgot to remove.
// os.tmpdir() reads these variables on every call; child processes inherit them. Removed on exit with the rest.
const tmpRoot = mkdtempSync(join(tmpdir(), "monomem-test-tmp-"));
process.env.TMPDIR = process.env.TMP = process.env.TEMP = tmpRoot;
const home = mkdtempSync(join(tmpRoot, "monomem-test-home-"));
process.env.MONOMEM_HOME = home;
// setup finds app configs through these (Claude Desktop under APPDATA, its Microsoft Store build under LOCALAPPDATA),
// and many tests spawn with { ...process.env, HOME: tmp }: without this they read, and could edit, the real files.
process.env.APPDATA = join(home, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(home, "AppData", "Local");
process.env.XDG_CONFIG_HOME = join(home, ".config");
// The suite exercises every tool, including the operator ones that a plain
// install no longer registers by default (see DEFAULT_TOOLS in
// mcp-server-core.ts). test/tool-surface.test.ts owns the assertions about
// what the DEFAULT surface is, and sets this variable itself.
// 1.6: "legacy-1.5,all" lists the 37 1.5 tools the suite was written against (the 1.6 tools call them and answer too);
// test/tool-surface-16.test.ts owns the 1.6 surface.
process.env.MONOMEM_TOOLS = "legacy-1.5,all";
// Bulk tests write thousands of notes as one agent label in seconds; the flood guard would pause them.
// test/access-log-flood.test.ts owns the flood-guard assertions and sets this variable itself.
process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "0";
// doctor asks the server on MONOMEM_PORT (default 8790) for its version: never a real one on this machine.
// test/health-version.test.ts owns those assertions, points MONOMEM_PORT at its own fake and clears this.
process.env.MONOMEM_NO_SERVER_PROBE = "1";
// Session start gives up after 5 s; on a loaded CI runner that cap fired in recall/everyday-cli/overdue-board tests.
process.env.MONOMEM_RECALL_TIMEOUT_MS = "30000";
// git-trail asks git quick questions with a 400 ms cap; a loaded Windows run spawned git slower than that and the merged-branch test flaked.
process.env.MONOMEM_GIT_TIMEOUT_MS = "5000";
process.env.MONOMEM_SCAN_CACHE_SECONDS = "0"; // the dashboard scans are cached for a minute in real use; tests want fresh answers
process.on("exit", () => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * MONOMEM_TEST_TIME_SCALE (tests only; CI sets it to 3 on the Windows and macOS runners): how much slower than a
 * developer machine this one may be. A wall-clock bound in a test is written for an idle machine and wrapped in slow(),
 * so a loaded runner gets more room while the bound still catches what it is there for (a fixed 5 s pause, a 20 s lock
 * wait, a 55 s timeout). Not a number, or below 1, counts as 1; at most 10.
 */
export function timeScale(raw: string | undefined = process.env.MONOMEM_TEST_TIME_SCALE): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 1;
}
export const slow = (ms: number): number => ms * timeScale();
