// Per-project scope (monomem scope): each git repo gets its own namespace without a spaces map.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";
import { autoScopeMode, autoScopeName, findRepoRoot, resolveAutoScope, resolveStartupNamespace } from "../src/namespace.js";
import { resolveRecallNamespace } from "../src/recall.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const tmp = (): string => mkdtempSync(join(tmpdir(), "monomem-autoscope-"));
const repo = (parent: string, name: string): string => {
  const d = join(parent, name);
  mkdirSync(join(d, ".git"), { recursive: true });
  mkdirSync(join(d, "src"), { recursive: true });
  return d;
};
function withEnv<T>(v: string | undefined, fn: () => T): T {
  const old = process.env.MONOMEM_AUTO_SCOPE;
  if (v === undefined) delete process.env.MONOMEM_AUTO_SCOPE;
  else process.env.MONOMEM_AUTO_SCOPE = v;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.MONOMEM_AUTO_SCOPE;
    else process.env.MONOMEM_AUTO_SCOPE = old;
  }
}
const cli = (args: string[], dataDir: string, env: Record<string, string> = {}, cwd?: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, NO_COLOR: "1", MONOMEM_HOME: dataDir, MONOMEM_DB_PATH: join(dataDir, "state.db"), MONOMEM_AUTO_SCOPE: "", ...env },
  });

describe("findRepoRoot", () => {
  test("finds the repo from a nested folder, and a .git file (worktree) counts", () => {
    const root = tmp();
    const a = repo(root, "alpha");
    assert.equal(findRepoRoot(join(a, "src"), join(root, "nohome")), realpathSync.native(a));
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "gitdir: elsewhere\n");
    assert.equal(findRepoRoot(wt, join(root, "nohome")), realpathSync.native(wt));
  });
  test("a folder reached through a link is the same project as its real path", (t) => {
    const root = tmp();
    const a = repo(root, "alpha");
    const link = join(root, "link");
    try {
      symlinkSync(a, link, "junction");
    } catch {
      t.skip("cannot create a link here");
      return;
    }
    assert.equal(findRepoRoot(join(link, "src"), join(root, "nohome")), realpathSync.native(a));
  });
  test("no repo, the home folder and a drive root give null", () => {
    const root = tmp();
    mkdirSync(join(root, "plain"));
    assert.equal(findRepoRoot(join(root, "plain"), join(root, "nohome")), null);
    const home = repo(root, "homerepo"); // a dotfiles repo in the home folder must not scope everything
    assert.equal(findRepoRoot(home, home), null);
    assert.equal(findRepoRoot(process.platform === "win32" ? "C:\\" : "/", join(root, "nohome")), null);
  });
});

describe("autoScopeName", () => {
  test("is stable, readable, and differs for two repos with the same name", () => {
    const root = tmp();
    const a = repo(join(root, "one"), "app");
    const b = repo(join(root, "two"), "app");
    assert.equal(autoScopeName(a), autoScopeName(a));
    assert.notEqual(autoScopeName(a), autoScopeName(b));
    assert.match(autoScopeName(a), /^app-[0-9a-f]{6}$/);
  });
});

describe("mode and resolution", () => {
  test("env wins in both directions; unset is off", () => {
    withEnv("1", () => assert.deepEqual(autoScopeMode(), { on: true, source: "env" }));
    withEnv("off", () => assert.deepEqual(autoScopeMode(), { on: false, source: "env" }));
    withEnv(undefined, () => assert.equal(autoScopeMode().on, false));
  });
  test("on: a repo gets its own namespace; off or no repo gives null", () => {
    const root = tmp();
    const a = repo(root, "alpha");
    mkdirSync(join(root, "plain"));
    withEnv("1", () => {
      assert.equal(resolveAutoScope(join(a, "src"))?.namespace, autoScopeName(a));
      assert.equal(resolveAutoScope(join(root, "plain")), null);
    });
    withEnv("0", () => assert.equal(resolveAutoScope(a), null));
  });
  test("the stdio path and the hook path agree; the HTTP path never scopes", async () => {
    const root = tmp();
    const a = repo(root, "alpha");
    process.env.MONOMEM_AUTO_SCOPE = "1";
    try {
      const stdio = resolveStartupNamespace(a, { auto: true });
      const hook = await resolveRecallNamespace(a);
      assert.equal(hook.kind, "resolved");
      assert.equal(hook.kind === "resolved" ? hook.namespace : null, stdio?.namespace);
      assert.equal(resolveStartupNamespace(a), null);
      process.env.MONOMEM_AUTO_SCOPE = "0";
      assert.equal((await resolveRecallNamespace(a)).kind, "disabled");
    } finally {
      delete process.env.MONOMEM_AUTO_SCOPE;
    }
  });
  test("a spaces map wins over auto scope", () => {
    const root = tmp();
    const a = repo(root, "alpha");
    const old = process.env.MONOMEM_SPACES;
    process.env.MONOMEM_SPACES = JSON.stringify({ spaces: { [root]: "mapped" }, default_namespace: "default" });
    try {
      withEnv("1", () => assert.equal(resolveStartupNamespace(a, { auto: true })?.namespace, "mapped"));
    } finally {
      if (old === undefined) delete process.env.MONOMEM_SPACES;
      else process.env.MONOMEM_SPACES = old;
    }
  });
});

describe("monomem scope", () => {
  test("on writes the marker for an empty store; off removes it; notes are untouched", () => {
    const dir = tmp();
    const on = cli(["scope", "on"], dir);
    assert.equal(on.status, 0, on.stderr);
    assert.equal(existsSync(join(dir, "auto-scope")), true);
    assert.equal(readFileSync(join(dir, "auto-scope"), "utf8").trim(), "on");
    assert.match(cli(["scope", "status"], dir).stdout, /ON/);
    const off = cli(["scope", "off"], dir);
    assert.equal(off.status, 0);
    assert.equal(existsSync(join(dir, "auto-scope")), false);
    assert.match(cli(["scope", "status"], dir).stdout, /OFF/);
  });
  test("on refuses when the store already has notes unless --yes", () => {
    const dir = tmp();
    const save = cli(["add", "an existing note about tea"], dir);
    assert.equal(save.status, 0, save.stderr + save.stdout);
    const refused = cli(["scope", "on"], dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /already has 1 note/);
    assert.equal(existsSync(join(dir, "auto-scope")), false);
    const ok = cli(["scope", "on", "--yes"], dir);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(existsSync(join(dir, "auto-scope")), true);
  });
  test("on refuses when a spaces map is set", () => {
    const dir = tmp();
    const r = cli(["scope", "on"], dir, { MONOMEM_SPACES: JSON.stringify({ spaces: {}, default_namespace: "default" }) });
    assert.equal(r.status, 1);
    assert.equal(existsSync(join(dir, "auto-scope")), false);
  });
  test("an unknown subcommand prints usage and exits 2", () => {
    const r = cli(["scope", "sideways"], tmp());
    assert.equal(r.status, 2);
    assert.match(r.stdout, /Usage: monomem scope/);
  });
  test("monomem add with no --ns saves into the repo's project when scope is on, and into default when off", () => {
    const root = tmp();
    const a = repo(root, "alpha");
    const dir = tmp();
    assert.match(cli(["add", "scoped note"], dir, { MONOMEM_AUTO_SCOPE: "1" }, a).stdout, /in alpha-[0-9a-f]{6}\./);
    assert.match(cli(["add", "plain note"], dir, { MONOMEM_AUTO_SCOPE: "0" }, a).stdout, /in default\./);
  });
  test("status shows the project for the folder it runs in", () => {
    const root = tmp();
    const a = repo(root, "alpha");
    const r = cli(["scope", "status"], tmp(), { MONOMEM_AUTO_SCOPE: "1" }, a);
    assert.match(r.stdout, new RegExp(`project "alpha-[0-9a-f]{6}"`));
  });
});
