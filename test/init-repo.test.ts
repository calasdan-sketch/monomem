// `monomem init repo`: the managed memory-loop block. Library-level tests on temp folders only (no store, no client config).
import "./setup-env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INIT_BEGIN, INIT_END, MDC_HEADER, applyInitPlans, chooseFiles, findRepoRoot, planInitFile, renderInitBlock, stripInitBlock, withInitBlock, withoutInitBlock } from "../src/init-block.js";
import { spawnSync } from "node:child_process";
import { splitSections } from "../src/claude-import.js";

let root = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "init-repo-")));
  mkdirSync(join(root, ".git"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const run = (files: string[], mode: "install" | "undo" = "install") => applyInitPlans(files.map((f) => planInitFile(root, f, mode)));

describe("init repo block", () => {
  test("the block is under 600 characters and names the loop", () => {
    const b = renderInitBlock();
    assert.ok(b.length < 600, `${b.length} chars`);
    for (const w of ["detail=index", "memory_read", "memory_save", "reason", "memory_replace", "conflicts_with", "who wrote"]) assert.ok(b.includes(w), w);
  });

  test("adds to an existing file, keeps user text byte for byte, and undo restores the original bytes", () => {
    const orig = "# My rules\n\nBe kind.\n  indented\ttab\n";
    writeFileSync(join(root, "CLAUDE.md"), orig);
    assert.deepEqual(run(["CLAUDE.md"]), ["CLAUDE.md"]);
    const after = readFileSync(join(root, "CLAUDE.md"), "utf8");
    assert.ok(after.startsWith(orig));
    assert.equal(after.split(INIT_BEGIN).length, 2);
    run(["CLAUDE.md"], "undo");
    assert.equal(readFileSync(join(root, "CLAUDE.md"), "utf8"), orig);
  });

  test("running twice changes nothing; an edited block is updated in place, text around it untouched", () => {
    writeFileSync(join(root, "AGENTS.md"), "top\n");
    run(["AGENTS.md"]);
    const once = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.equal(planInitFile(root, "AGENTS.md", "install").action, "unchanged");
    assert.deepEqual(run(["AGENTS.md"]), []);
    const edited = once.replace("do not save a duplicate", "STALE").replace("top\n", "top\nmine\n") + "tail after\n";
    writeFileSync(join(root, "AGENTS.md"), edited);
    assert.equal(planInitFile(root, "AGENTS.md", "install").action, "update");
    run(["AGENTS.md"]);
    const fixed = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.ok(fixed.startsWith("top\nmine\n") && fixed.endsWith("tail after\n") && !fixed.includes("STALE"));
  });

  test("CRLF files get CRLF blocks and undo is exact", () => {
    const orig = "line one\r\nline two\r\n";
    writeFileSync(join(root, "AGENTS.md"), orig);
    run(["AGENTS.md"]);
    const t = readFileSync(join(root, "AGENTS.md"), "utf8");
    assert.ok(!/[^\r]\n/.test(t), "no bare LF");
    run(["AGENTS.md"], "undo");
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), orig);
  });

  test("a new file is created and undo deletes it; a new Cursor rule gets frontmatter", () => {
    run(["AGENTS.md", "cursor"]);
    assert.ok(readFileSync(join(root, ".cursor", "rules", "monomem.mdc"), "utf8").startsWith(MDC_HEADER));
    run(["AGENTS.md", "cursor"], "undo");
    assert.ok(!existsSync(join(root, "AGENTS.md")) && !existsSync(join(root, ".cursor", "rules", "monomem.mdc")));
  });

  test("broken markers are refused, nothing written", () => {
    writeFileSync(join(root, "AGENTS.md"), `x\n${INIT_BEGIN}\nno end\n`);
    const p = planInitFile(root, "AGENTS.md", "install");
    assert.match(p.refused ?? "", /broken/);
    assert.deepEqual(applyInitPlans([p]), []);
    assert.equal(withoutInitBlock("plain"), "plain");
    assert.equal(stripInitBlock(`x\n${INIT_BEGIN}\nno end\n`), `x\n${INIT_BEGIN}\nno end\n`);
  });

  test("symlinked file, symlinked folder and a link out of the repo are refused", (t) => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "init-out-")));
    try {
      writeFileSync(join(outside, "real.md"), "outside\n");
      let fileLink = false;
      let dirLink = false;
      try {
        symlinkSync(join(outside, "real.md"), join(root, "AGENTS.md"), "file");
        fileLink = true;
      } catch {
        /* no symlink right on this machine */
      }
      try {
        symlinkSync(outside, join(root, ".cursor"), "junction");
        dirLink = true;
      } catch {
        /* ditto */
      }
      if (!fileLink && !dirLink) return t.skip("cannot create links here");
      if (fileLink) assert.match(planInitFile(root, "AGENTS.md", "install").refused ?? "", /symbolic link/);
      if (dirLink) assert.match(planInitFile(root, "cursor", "install").refused ?? "", /symbolic link/);
      run(["AGENTS.md", "cursor"]);
      assert.equal(readFileSync(join(outside, "real.md"), "utf8"), "outside\n");
      assert.ok(!existsSync(join(outside, "rules")));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("the file choice: existing files, else AGENTS.md; undo never invents one", () => {
    assert.deepEqual(chooseFiles(root, undefined, "install"), ["AGENTS.md"]);
    assert.deepEqual(chooseFiles(root, undefined, "undo"), []);
    writeFileSync(join(root, "CLAUDE.md"), "x");
    mkdirSync(join(root, ".cursor"));
    assert.deepEqual(chooseFiles(root, undefined, "install"), ["CLAUDE.md", "cursor"]);
  });

  test("findRepoRoot needs a .git above", () => {
    assert.equal(findRepoRoot(root), root);
    const lone = realpathSync(mkdtempSync(join(tmpdir(), "init-nogit-")));
    try {
      // tmpdir itself is not inside a repository on a normal machine; if it is, skip the claim
      const r = findRepoRoot(lone);
      assert.ok(r === null || r !== lone);
    } finally {
      rmSync(lone, { recursive: true, force: true });
    }
  });

  test("the importers do not store the block as a note", () => {
    const text = `# Rules\nUse tabs.\n\n${withInitBlock("").trimEnd()}\n`;
    const { sections } = splitSections(text, "x");
    const all = sections.map((s) => s.body).join("\n");
    assert.ok(all.includes("Use tabs") && !all.includes("memory_search") && !all.includes("Shared memory"));
    assert.ok(withInitBlock("a\n").includes(INIT_END));
  });
});

describe("monomem init repo (the real CLI, temp folders and homes)", () => {
  const cli = join(import.meta.dirname, "..", "src", "cli.js");
  const sh = (args: string[]) => {
    const tmp = join(root, "..", "init-cli-home-" + process.pid);
    mkdirSync(tmp, { recursive: true });
    const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: tmp, USERPROFILE: tmp, MONOMEM_HOME: tmp, ONEMEMORY_HOME: tmp, MONOMEM_AUDIT_LOG: join(tmp, "a.log") };
    const r = spawnSync(process.execPath, [cli, "init", "repo", ...args], { cwd: root, env, encoding: "utf8" });
    rmSync(tmp, { recursive: true, force: true });
    return r;
  };

  test("default is a dry run with a diff; --yes writes; --undo --yes removes exactly the block; not a repo is refused", () => {
    writeFileSync(join(root, "AGENTS.md"), "mine\n");
    const dry = sh([]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /\+ .*Shared memory/);
    assert.match(dry.stdout, /Nothing written/);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "mine\n");
    assert.equal(sh(["--yes"]).status, 0);
    assert.ok(readFileSync(join(root, "AGENTS.md"), "utf8").includes(INIT_BEGIN));
    assert.match(sh([]).stdout, /up to date/);
    assert.equal(sh(["--undo", "--yes"]).status, 0);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "mine\n");
    rmSync(join(root, ".git"), { recursive: true });
    const refused = sh(["--yes"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /git repository/);
  });

  test("a bare `init` still prints the wiring snippet (not a TTY)", () => {
    const tmp = join(root, "bare");
    mkdirSync(tmp);
    const r = spawnSync(process.execPath, [cli, "init"], { cwd: root, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: tmp, USERPROFILE: tmp, MONOMEM_HOME: tmp, ONEMEMORY_HOME: tmp, MONOMEM_AUDIT_LOG: join(tmp, "a.log") }, encoding: "utf8" });
    assert.match(r.stdout, /Wire monomem/);
  });
});
