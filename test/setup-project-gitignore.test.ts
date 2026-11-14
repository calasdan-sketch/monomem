// 1.5.0 R1-11: a key must not be written into ./.mcp.json of a git repository that does not ignore that file (it would be committed).
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OPTIONS, detectClients, planFile, realEnv } from "../src/setup.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function repo(init: boolean): { env: ReturnType<typeof realEnv>; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "mm-gitign-"));
  roots.push(root);
  const dir = join(root, "proj");
  mkdirSync(dir);
  if (init) execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return { dir, env: { ...realEnv("1.5.0", "/x/cli.js"), home: join(root, "home"), cwd: dir, platform: process.platform, env: {} } };
}
const keyed = { ...DEFAULT_OPTIONS, project: true, only: ["project"], httpEntry: { url: "http://127.0.0.1:8791/mcp", headers: { Authorization: "Bearer k" } } };
const plan = (r: ReturnType<typeof repo>, opts: typeof keyed | typeof DEFAULT_OPTIONS) => planFile(r.env, opts, detectClients(r.env).find((t) => t.id === "project")!, { dbs: new Set() });

describe("R1-11 --project with a key", () => {
  test("a git repository that does not ignore .mcp.json: the keyed entry is refused, even with --yes", () => {
    const r = repo(true);
    for (const yes of [false, true]) {
      const p = plan(r, { ...keyed, yes });
      assert.equal(p.change, null);
      assert.match(p.conflicts.join(" "), /git repository and \.mcp\.json is not ignored, so the key would be committed/);
      assert.match(p.conflicts.join(" "), /Add \.mcp\.json to \.gitignore, or connect without --project/);
    }
  });

  test("with .mcp.json in .gitignore the keyed entry is planned", () => {
    const r = repo(true);
    writeFileSync(join(r.dir, ".gitignore"), ".mcp.json\n");
    const p = plan(r, keyed);
    assert.equal(p.conflicts.length, 0, p.conflicts.join(" "));
    assert.ok(p.change);
  });

  test("outside a git repository, and for a keyless entry, nothing changes", () => {
    const plain = repo(false);
    assert.equal(plan(plain, keyed).conflicts.length, 0);
    const g = repo(true);
    const keyless = plan(g, { ...DEFAULT_OPTIONS, project: true, only: ["project"] });
    assert.equal(keyless.conflicts.join(" ").includes("committed"), false);
    assert.ok(keyless.change);
  });
});
