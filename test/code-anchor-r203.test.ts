// R2-03 (1.5.0): code-anchored staleness. A note names the files it is about; when a later commit changes one, reads and
// session start label it `[code changed since this was written: <path>]` and it joins `monomem review` / `stale --code`.
// One `git ls-tree` per HEAD (spy). No git repository: exactly the old behaviour. Paths outside the repository are refused.
import "./setup-env.js";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { gitStats } from "../src/code-anchor.js";
import { injectContext } from "../src/context-inject.js";

const NO_GIT = { signals: { branch: "", diffFiles: [] } };
let root = "";
let repo = "";
let outside = "";
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
const commit = (path: string, text: string) => {
  writeFileSync(join(repo, path), text);
  git("add", "--", path);
  git("commit", "-q", "-m", `edit ${path}`);
};
const at = <T>(cwd: string, fn: () => T): T => actorStore.run({ label: "stdio:claude", cwd }, fn);

before(() => {
  root = mkdtempSync(join(tmpdir(), "om-r203-"));
  repo = join(root, "repo");
  outside = join(root, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "x");
  git("init", "-q");
  commit("src/auth.ts", "export const a = 1;\n");
  commit("src/db.ts", "export const d = 1;\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("R2-03 code anchors", () => {
  test("a commit that changes an anchored file labels the note; one git ls-tree per HEAD", async () => {
    const s = new Store(":memory:");
    const n = at(repo, () => s.create({ title: "auth uses a token", body: "see auth" }, { files: ["src/auth.ts", "./src/db.ts"] }));
    assert.equal(s.read(n.id)!.code_changed, undefined, "nothing changed yet");
    const before = gitStats.lsTree;
    s.read(n.id);
    s.read(n.id);
    assert.ok(gitStats.lsTree - before <= 1, "at most one ls-tree for this HEAD");
    commit("src/auth.ts", "export const a = 2;\n");
    const mid = gitStats.lsTree;
    const r = s.read(n.id)!;
    assert.equal(gitStats.lsTree - mid, 1, "one ls-tree for the new HEAD");
    assert.equal(r.code_changed!.length, 1);
    assert.equal(r.code_changed![0].path, "src/auth.ts");
    assert.match(r.code_changed![0].since_commit, /^[0-9a-f]{12}$/);
    assert.equal(r.code_changed_label, "[code changed since this was written: src/auth.ts]");
    for (let i = 0; i < 5; i++) s.read(n.id);
    assert.equal(gitStats.lsTree - mid, 1, "cached per HEAD");
    // Session start shows the label; the note is not hidden for it.
    const ctx = await injectContext(s, NO_GIT);
    assert.match(ctx, /auth uses a token.*\[code changed since this was written: src\/auth\.ts\]/);
    // review / stale --code list it; a person keeps it and the anchors move to HEAD.
    assert.deepEqual(s.codeChangedList().map((x) => x.id), [n.id]);
    assert.equal(s.refreshCodeAnchors(n.id), 1);
    assert.equal(s.read(n.id)!.code_changed, undefined);
    assert.deepEqual(s.codeChangedList(), []);
    s.close();
  });

  test("a pinned note stays pinned and is labelled", async () => {
    const s = new Store(":memory:");
    const n = at(repo, () => s.create({ title: "db pool size is 5", body: "pool" }, { files: ["src/db.ts"] }));
    s.setPinned(n.id, true);
    commit("src/db.ts", "export const d = 2;\n");
    const r = s.read(n.id)!;
    assert.equal(r.pinned, true);
    assert.match(r.code_changed_label!, /src\/db\.ts/);
    const ctx = await injectContext(s, NO_GIT);
    assert.match(ctx, /Pinned \(always shown\):\n#\d+.*db pool size is 5.*\[code changed since this was written: src\/db\.ts\]/);
    s.close();
  });

  test("a deleted file counts as changed; deleting the note removes its anchors", () => {
    const s = new Store(":memory:");
    commit("src/gone.ts", "x\n");
    const n = at(repo, () => s.create({ title: "gone helper", body: "b" }, { files: ["src/gone.ts"] }));
    git("rm", "-q", "--", "src/gone.ts");
    git("commit", "-q", "-m", "rm");
    assert.equal(s.read(n.id)!.code_changed![0].path, "src/gone.ts");
    s.delete(n.id);
    assert.equal((s.db.prepare("SELECT count(*) AS c FROM code_anchors").get() as { c: number }).c, 0);
    s.close();
  });

  test("paths outside the repository, '..', untracked files and folders are refused", () => {
    const s = new Store(":memory:");
    const bad: Array<[string[], RegExp]> = [
      [["../outside/secret.txt"], /'\.\.'/],
      [["src/../../outside/secret.txt"], /'\.\.'/],
      [[join(outside, "secret.txt")], /inside this repository/],
      [["src/new.ts"], /not tracked/],
      [["src"], /files, not folders/],
      [Array.from({ length: 21 }, (_, i) => `f${i}`), /at most 20/],
    ];
    writeFileSync(join(repo, "src", "new.ts"), "untracked");
    for (const [files, why] of bad) {
      assert.throws(() => at(repo, () => s.create({ title: "t", body: "b" }, { files })), why, files.join(","));
    }
    let linked = false;
    try {
      symlinkSync(outside, join(repo, "escape"), "junction");
      linked = true;
    } catch {
      /* no symlink rights here: the realpath check is still covered by the absolute-path case */
    }
    if (linked) assert.throws(() => at(repo, () => s.create({ title: "t", body: "b" }, { files: ["escape/secret.txt"] })), /outside this repository/);
    assert.equal(s.list({ limit: 10 }).total, 0, "nothing was written");
    s.close();
  });

  test("monomem stale --code lists the note with the changed file", async () => {
    const { DB_PATH, PROJECT_ROOT } = await import("../src/config.js");
    commit("src/cli-case.ts", "a\n");
    const s = new Store(DB_PATH);
    const n = at(repo, () => s.create({ title: "cli case", body: "b" }, { files: ["src/cli-case.ts"] }));
    s.close();
    commit("src/cli-case.ts", "b\n");
    const out = execFileSync(process.execPath, [join(PROJECT_ROOT, "dist", "src", "cli.js"), "stale", "--code", "--json"], { encoding: "utf8" });
    const list = (JSON.parse(out) as { code_changed: Array<{ id: number; changed: Array<{ path: string }> }> }).code_changed;
    assert.deepEqual(list.map((x) => [x.id, x.changed[0].path]), [[n.id, "src/cli-case.ts"]]);
  });

  test("final-architecture SF-1: a repository whose .git went away does not spawn git on every read", () => {
    const repo2 = join(root, "repo2");
    mkdirSync(repo2);
    const g2 = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo2, stdio: "pipe" });
    g2("init", "-q");
    writeFileSync(join(repo2, "a.ts"), "a\n");
    g2("add", "--", "a.ts");
    g2("commit", "-q", "-m", "a");
    const s = new Store(":memory:");
    const n = at(repo2, () => s.create({ title: "about a", body: "b" }, { files: ["a.ts"] }));
    rmSync(join(repo2, ".git"), { recursive: true, force: true });
    const before = gitStats.revParse;
    for (let i = 0; i < 5; i++) assert.equal(s.read(n.id)!.code_changed, undefined);
    assert.ok(gitStats.revParse - before <= 1, `git rev-parse ran ${gitStats.revParse - before} times for 5 reads`);
    s.close();
  });

  test("outside a git repository: the note is written as before, with no anchors and no label", () => {
    const s = new Store(":memory:");
    const n = at(outside, () => s.create({ title: "plain", body: "b" }, { files: ["secret.txt"] }));
    assert.equal((s.db.prepare("SELECT count(*) AS c FROM code_anchors").get() as { c: number }).c, 0);
    assert.equal(s.read(n.id)!.code_changed, undefined);
    s.close();
  });
});
