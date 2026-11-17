// Quiet defaults: check shows only what needs a look (a person at a terminal; --verbose and piped output get every line),
// the first-run key line comes after a command's own output, and every CLI error reads "Error: ..." with a "Fix: ...".
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";
import { renderHealth, type HealthReport } from "../src/health.js";
import { errorLine } from "../src/cli/shared.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");

describe("check output", () => {
  const report = {
    grade: "B",
    rule: "RULE TEXT",
    not_covered: "Not covered: x.",
    checks: [
      { label: "Node", status: "ok", text: "fine" },
      { label: "Hooks", status: "info", text: "about hooks" },
      { label: "Backups", status: "warn", text: "no backup yet" },
    ],
  } as unknown as HealthReport;

  test("quiet: only the warning, a count of the rest, the grade and what is not covered", () => {
    const out = renderHealth(report, false);
    assert.match(out, /Backups: no backup yet/);
    assert.doesNotMatch(out, /Node: fine|about hooks|RULE TEXT/);
    assert.match(out, /2 check\(s\) fine/);
    assert.match(out, /Grade B/);
    assert.match(out, /Not covered/);
  });

  test("verbose: every line and the rule", () => {
    const out = renderHealth(report, true);
    for (const t of ["Node: fine", "about hooks", "Rule: RULE TEXT"]) assert.ok(out.includes(t), t);
  });
});

describe("first-run key line", () => {
  test("is said once, after the command's own output, in plain words", () => {
    const home = mkdtempSync(join(tmpdir(), "om-quiet-"));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home, MONOMEM_HOME: join(home, "data"), NO_COLOR: "1" } as NodeJS.ProcessEnv;
      delete env.MONOMEM_TOKEN;
      assert.equal(spawnSync(process.execPath, [CLI, "add", "first note", "--title", "first"], { encoding: "utf8", env }).status, 0);
      const r = spawnSync(process.execPath, [CLI, "check"], { encoding: "utf8", env });
      assert.ok(r.status === 0 || r.status === 1, r.stderr);
      assert.doesNotMatch(r.stderr, /bearer token/i);
      const lines = r.stderr.split("\n").filter(Boolean);
      assert.equal(lines.filter((l) => /Made the main app key/.test(l)).length, 1, r.stderr);
      assert.match(lines[lines.length - 1], /Made the main app key/, "last, not in the middle");
      const again = spawnSync(process.execPath, [CLI, "check"], { encoding: "utf8", env });
      assert.doesNotMatch(again.stderr, /Made the main app key/, "only on the run that made it");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("one error form", () => {
  test("errorLine: Error: sentence case, then Fix:", () => {
    assert.equal(errorLine("no note with id 5", "monomem ls lists them"), "Error: No note with id 5\nFix: monomem ls lists them");
    assert.equal(errorLine("Error: already said"), "Error: Already said");
  });

  test("an unknown command uses it", () => {
    const r = spawnSync(process.execPath, [CLI, "nosuchcommand"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^Error: Unknown command 'nosuchcommand'\.\nFix: monomem help/);
  });
});
