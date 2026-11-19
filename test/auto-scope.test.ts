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

describe("git worktrees and submodules", () => {
  const noHome = (root: string): string => join(root, "nohome");
  test("a worktree belongs to the repository it was made from (absolute and relative gitdir)", () => {
    const root = tmp();
    const main = repo(root, "main");
    mkdirSync(join(main, ".git", "worktrees", "wt1"), { recursive: true });
    const wt = join(root, "wt");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt1")}\n`);
    writeFileSync(join(main, ".git", "worktrees", "wt1", "gitdir"), `${join(wt, ".git")}\n`); // git's own back-pointer
    assert.equal(findRepoRoot(join(wt, "src"), noHome(root)), realpathSync.native(main));
    assert.equal(autoScopeName(findRepoRoot(wt, noHome(root))!), autoScopeName(main));
    const wt2 = join(root, "wt2");
    mkdirSync(wt2);
    mkdirSync(join(main, ".git", "worktrees", "wt2"), { recursive: true });
    writeFileSync(join(wt2, ".git"), "gitdir: ../main/.git/worktrees/wt2\n");
    writeFileSync(join(main, ".git", "worktrees", "wt2", "gitdir"), "../../../../wt2/.git\n"); // relative back-pointer
    assert.equal(findRepoRoot(wt2, noHome(root)), realpathSync.native(main));
  });
  test("a forged worktree (a .git file naming someone else's repository, no back-pointer to it) stays its own project", () => {
    const root = tmp();
    const victim = repo(root, "victim");
    mkdirSync(join(victim, ".git", "worktrees", "w"), { recursive: true });
    const evil = join(root, "evil");
    mkdirSync(evil);
    writeFileSync(join(evil, ".git"), `gitdir: ${join(victim, ".git", "worktrees", "w")}\n`);
    assert.equal(findRepoRoot(evil, noHome(root)), realpathSync.native(evil), "no gitdir file inside the victim's worktrees/w");
    // A back-pointer that names a different folder is no better.
    writeFileSync(join(victim, ".git", "worktrees", "w", "gitdir"), `${join(root, "someone-else", ".git")}\n`);
    assert.equal(findRepoRoot(evil, noHome(root)), realpathSync.native(evil), "back-pointer names another folder");
    assert.notEqual(autoScopeName(findRepoRoot(evil, noHome(root))!), autoScopeName(victim));
  });
  test("a submodule, a worktree whose main repository is gone, and a bare repository stay their own project", () => {
    const root = tmp();
    const main = repo(root, "main");
    mkdirSync(join(main, ".git", "modules", "sub"), { recursive: true });
    const sub = join(main, "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    assert.equal(findRepoRoot(sub, noHome(root)), realpathSync.native(sub));
    const orphan = join(root, "orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, ".git"), `gitdir: ${join(root, "gone", ".git", "worktrees", "x")}\n`);
    assert.equal(findRepoRoot(orphan, noHome(root)), realpathSync.native(orphan));
    mkdirSync(join(root, "bare.git", "worktrees", "w"), { recursive: true });
    const wtBare = join(root, "wtbare");
    mkdirSync(wtBare);
    writeFileSync(join(wtBare, ".git"), `gitdir: ${join(root, "bare.git", "worktrees", "w")}\n`);
    assert.equal(findRepoRoot(wtBare, noHome(root)), realpathSync.native(wtBare));
  });
});

describe("reads follow per-project scope", () => {
  const on = { MONOMEM_AUTO_SCOPE: "1" };
  function seeded(): { dir: string; a: string; b: string } {
    const root = tmp();
    const a = repo(root, "alpha");
    const b = repo(root, "beta");
    const dir = tmp();
    assert.equal(cli(["add", "alpha tea note"], dir, on, a).status, 0);
    assert.equal(cli(["add", "beta tea note"], dir, on, b).status, 0);
    return { dir, a, b };
  }
  test("search, relevant and ls look in this repository's project and say so; --all-projects sees everything", () => {
    const { dir, a } = seeded();
    for (const verb of ["search", "relevant"]) {
      const mine = cli([verb, "tea"], dir, on, a).stdout;
      assert.match(mine, /Searching only this project \("alpha-[0-9a-f]{6}"\)/, verb);
      assert.match(mine, /alpha tea note/);
      assert.doesNotMatch(mine, /beta tea note/);
      const all = cli([verb, "tea", "--all-projects"], dir, on, a).stdout;
      assert.doesNotMatch(all, /Searching only this project/);
      assert.match(all, /alpha tea note/);
      assert.match(all, /beta tea note/);
    }
    const ls = cli(["ls"], dir, on, a).stdout;
    assert.match(ls, /Searching only this project/);
    assert.match(ls, /alpha tea note/);
    assert.doesNotMatch(ls, /beta tea note/);
    assert.match(cli(["ls", "--all-projects"], dir, on, a).stdout, /beta tea note/);
    assert.doesNotMatch(cli(["search", "--all-projects"], dir, on, a).stdout, /Searching only/);
  });
  test("a miss in the project points at --all-projects; an explicit --ns wins; --json keeps stdout clean", () => {
    const { dir, a } = seeded();
    assert.match(cli(["search", "zzzunknown"], dir, on, a).stdout, /Nothing in this project\. To look in every project: add --all-projects/);
    const other = cli(["ls", "--ns", "default"], dir, on, a).stdout;
    assert.doesNotMatch(other, /Searching only/);
    const j = cli(["search", "tea", "--json"], dir, on, a);
    assert.doesNotThrow(() => JSON.parse(j.stdout));
    assert.match(j.stderr, /Searching only this project/);
  });
  test("scope off, or a folder outside any repository: nothing changes", () => {
    const { dir, a } = seeded();
    const off = cli(["search", "tea"], dir, { MONOMEM_AUTO_SCOPE: "0" }, a).stdout;
    assert.doesNotMatch(off, /Searching only/);
    assert.match(off, /alpha tea note/);
    assert.match(off, /beta tea note/);
    const plain = tmp();
    assert.doesNotMatch(cli(["ls"], dir, on, plain).stdout, /Searching only/);
  });
});

describe("monomem scope adopt", () => {
  const on = { MONOMEM_AUTO_SCOPE: "1" };
  function orphaned(): { dir: string; a: string; mine: string } {
    const root = tmp();
    const a = repo(root, "alpha");
    const dir = tmp();
    assert.equal(cli(["add", "orphan one", "--ns", "oldproj"], dir, on, a).status, 0);
    assert.equal(cli(["add", "orphan two", "--ns", "oldproj"], dir, on, a).status, 0);
    return { dir, a, mine: autoScopeName(realpathSync.native(a)) };
  }
  test("status lists the other projects with their counts", () => {
    const { dir, a } = orphaned();
    assert.match(cli(["scope", "status"], dir, on, a).stdout, /Other projects: oldproj \(2 notes\)/);
  });
  test("shows the count and needs --yes, then moves the notes and keeps their history", () => {
    const { dir, a, mine } = orphaned();
    const asked = cli(["scope", "adopt", "oldproj"], dir, on, a);
    assert.equal(asked.status, 1);
    assert.match(asked.stdout, /2 notes saved under "oldproj" would be moved into this folder's project/);
    assert.match(cli(["show", "1"], dir, on, a).stdout, /\[oldproj\]/);
    const done = cli(["scope", "adopt", "oldproj", "--yes"], dir, on, a);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.match(done.stdout, /Moved 2 notes from "oldproj"/);
    const shown = JSON.parse(cli(["show", "1", "--json"], dir, on, a).stdout);
    assert.equal(shown.namespace, mine);
    assert.equal(shown.rev, 2);
    assert.equal(shown.body, "orphan one");
    assert.match(cli(["ls"], dir, on, a).stdout, /orphan two/);
    assert.doesNotMatch(cli(["scope", "status"], dir, on, a).stdout, /oldproj/);
  });
  test("refuses with no repository, scope off, no name, a spaces map, an unknown name or the current project", () => {
    const { dir, a, mine } = orphaned();
    const plain = tmp();
    const noRepo = cli(["scope", "adopt", "oldproj", "--yes"], dir, on, plain);
    assert.equal(noRepo.status, 1);
    assert.match(noRepo.stdout, /not inside a git repository/);
    const off = cli(["scope", "adopt", "oldproj", "--yes"], dir, { MONOMEM_AUTO_SCOPE: "0" }, a);
    assert.equal(off.status, 1);
    assert.match(off.stdout, /scope is OFF/);
    assert.equal(cli(["scope", "adopt"], dir, on, a).status, 2);
    assert.equal(cli(["scope", "adopt", "oldproj", "--yes"], dir, { ...on, MONOMEM_SPACES: JSON.stringify({ spaces: {}, default_namespace: "default" }) }, a).status, 1);
    const unknown = cli(["scope", "adopt", "nosuch", "--yes"], dir, on, a);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stdout, /no notes under the project name "nosuch"/);
    assert.match(cli(["scope", "adopt", mine, "--yes"], dir, on, a).stdout, /already this folder's project/);
    assert.match(cli(["show", "1"], dir, on, a).stdout, /\[oldproj\]/); // nothing moved by any of the refusals
  });
});

describe("a MONOMEM_AUTO_SCOPE value that is not understood", () => {
  test("warns once on stderr, is ignored, and status says so; valid values are quiet", () => {
    const dir = tmp();
    const bad = cli(["scope", "status"], dir, { MONOMEM_AUTO_SCOPE: "ture" });
    assert.equal((bad.stderr.match(/not understood/g) ?? []).length, 1, bad.stderr);
    assert.match(bad.stdout, /Per-project scope: OFF/);
    assert.match(bad.stdout, /"ture", which is not understood/);
    for (const v of ["1", "0", "on", "off", ""]) assert.doesNotMatch(cli(["scope", "status"], dir, { MONOMEM_AUTO_SCOPE: v }).stderr, /not understood/, v);
    withEnv("ture", () => assert.deepEqual(autoScopeMode(), { on: false, source: "off", invalid: "ture" }));
  });
  test("monomem check shows the scope line, and warns about the bad value", () => {
    const dir = tmp();
    const ok = cli(["check", "--verbose", "--quick"], dir, { MONOMEM_AUTO_SCOPE: "1" });
    assert.match(ok.stdout, /Per-project scope: on, but this folder is not in a git repository|Per-project scope: on: this folder is in the project/);
    const bad = cli(["check", "--verbose", "--quick"], dir, { MONOMEM_AUTO_SCOPE: "ture" });
    assert.match(bad.stdout, /\[warn\] Per-project scope: MONOMEM_AUTO_SCOPE is set to "ture"/);
  });
});
