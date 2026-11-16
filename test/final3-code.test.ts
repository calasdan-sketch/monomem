// Final release panel round 3 (1.5.0): the code should-fix items.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "om-final3-"));
  dirs.push(d);
  return d;
}
function run(dir: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db"), HOME: dir, USERPROFILE: dir, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: tmpdir(), env, encoding: "utf8" });
}

describe("EASE-SF1: no stray signing-key warning from the throwaway bench stores", () => {
  for (const cmd of ["demo", "drill", "health"]) {
    test(`${cmd}: stderr does not mention another store's signing key`, () => {
      const dir = tmp();
      if (cmd !== "demo") run(dir, ["add", "a note", "--body", "about forklifts"]);
      const r = run(dir, [cmd]);
      assert.doesNotMatch(r.stderr, /not replacing the signing key/, r.stderr);
    });
  }
});
