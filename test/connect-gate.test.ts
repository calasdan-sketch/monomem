// 1.5.0 R1-08: `monomem connect` cannot mint a write key without a person at a terminal.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "dist/src/cli.js");
function cli(home: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, MONOMEM_HOME: home, MONOMEM_DB_PATH: join(home, "state.db"), MONOMEM_TOKEN: "t".repeat(40) },
    encoding: "utf8",
    input: "",
  });
}
const tokensFile = (home: string): string => (existsSync(join(home, "tokens.json")) ? readFileSync(join(home, "tokens.json"), "utf8") : "");

describe("R1-08 connect mints keys only for a person", () => {
  for (const flags of [["--print"], ["--restricted"], ["--max", "private"], ["--print", "--restricted"]]) {
    test(`connect cursor ${flags.join(" ")} without a terminal is refused and tokens.json is unchanged`, () => {
      const home = mkdtempSync(join(tmpdir(), "om-conngate-"));
      try {
        const before = tokensFile(home);
        const r = cli(home, ["connect", "cursor", ...flags]);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stderr, /Refused:/);
        assert.equal(tokensFile(home), before);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  test("--dry-run still works without a terminal and creates nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "om-conngate-"));
    try {
      const r = cli(home, ["connect", "cursor", "--restricted", "--dry-run"]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /dry run/i);
      assert.equal(tokensFile(home), "");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
