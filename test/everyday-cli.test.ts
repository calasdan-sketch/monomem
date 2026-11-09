// monomem add / show / ls / forget / edit / search-with-no-words: everyday commands that go through the normal store path.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
function run(dir: string, args: string[], input?: string, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "t.db"), ...extra },
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
}

describe("everyday commands", () => {
  test("add, ls, show, search with no words, forget, restore", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-everyday-"));
    try {
      const a = run(dir, ["add", "I prefer tabs over spaces in every project", "--ns", "work", "--tag", "style,code"]);
      assert.equal(a.status, 0, a.stderr);
      assert.match(a.stdout, /Saved #1 "I prefer tabs over spaces in every project" in work/);
      const p = run(dir, ["add", "-", "--title", "From a pipe", "--private"], "piped body text");
      assert.equal(p.status, 0, p.stderr);
      assert.match(p.stdout, /Saved #2 "From a pipe".*\(private\)/);
      assert.match(p.stdout, /apps with no limit/i);
      const ls = run(dir, ["ls", "--ns", "work"]);
      assert.match(ls.stdout, /#1 \[work\]/);
      assert.ok(!ls.stdout.includes("#2"));
      assert.match(run(dir, ["search"]).stdout, /#2 /, "search with no words lists notes");
      const show = run(dir, ["show", "2"]);
      assert.match(show.stdout, /label: private/);
      assert.match(show.stdout, /piped body text/);
      assert.match(show.stdout, /written by: cli/);
      assert.equal(run(dir, ["forget", "1"]).status, 0);
      assert.ok(!run(dir, ["ls"]).stdout.includes("#1 "));
      assert.equal(run(dir, ["restore", "1"]).status, 0);
      assert.match(run(dir, ["ls"]).stdout, /#1 /);
      assert.equal(run(dir, ["show", "99"]).status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("add refuses a secret like every other write, and rejects bad options", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-everyday-"));
    try {
      const r = run(dir, ["add", "my key is sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4"]);
      assert.notEqual(r.status, 0, r.stdout);
      assert.match(r.stderr + r.stdout, /secret|key|credential|held|quarantine/i);
      assert.equal(run(dir, ["add", "x", "--sens", "secret"]).status, 1);
      assert.equal(run(dir, ["add", "x", "--bogus"]).status, 1);
      assert.equal(run(dir, ["add"]).status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("edit saves what the editor wrote, and says so when nothing changed", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-everyday-"));
    try {
      run(dir, ["add", "old body", "--title", "Old title"]);
      const ed = join(dir, "ed.js");
      writeFileSync(ed, 'const fs=require("fs");const f=process.argv[2];fs.writeFileSync(f,"New title\\n\\nnew body");');
      const r = run(dir, ["edit", "1", "--editor"], undefined, { EDITOR: `"${process.execPath}" "${ed}"` });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Saved #1 \(version 2\)/);
      assert.match(run(dir, ["show", "1"]).stdout, /new body/);
      const same = join(dir, "same.js");
      writeFileSync(same, "");
      const n = run(dir, ["edit", "1", "--editor"], undefined, { EDITOR: `"${process.execPath}" "${same}"` });
      assert.match(n.stdout, /No changes/);
      const missing = run(dir, ["edit", "999"], undefined, { EDITOR: "", VISUAL: "" });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr + missing.stdout, /No note #999/, "the id is checked before the editor");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("edit hands the editor exactly one argument, the file path, even in a folder with a space", () => {
    const dir = mkdtempSync(join(tmpdir(), "om everyday sp-"));
    try {
      run(dir, ["add", "body", "--title", "T"]);
      const rec = join(dir, "argv.json");
      const ed = join(dir, "rec ed.js");
      writeFileSync(ed, `require("fs").writeFileSync(${JSON.stringify(rec)}, JSON.stringify(process.argv.slice(2)));`);
      const r = run(dir, ["edit", "1", "--editor"], undefined, { EDITOR: `"${process.execPath}" "${ed}"`, TMP: dir, TEMP: dir, TMPDIR: dir });
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /DEP0190/);
      const argv = JSON.parse(readFileSync(rec, "utf8")) as string[];
      assert.equal(argv.length, 1, JSON.stringify(argv));
      assert.match(argv[0], /note-1\.md$/);
      assert.ok(argv[0].includes(" "), "the temp folder has a space, and the path arrived whole");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("label private says plainly who can still see it, with a next step", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-everyday-"));
    try {
      run(dir, ["add", "hello there"]);
      const r = run(dir, ["label", "1", "private"]);
      assert.match(r.stdout, /apps with no limit \(including your main Claude connection\) still can/);
      assert.match(r.stdout, /monomem connect <app> --max internal/);
      assert.match(r.stdout, /MONOMEM_RECALL_MAX_SENSITIVITY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("search, relevant and recall polish", () => {
  test("relevant shows a snippet; --help lists real options; recall --text is human text while the hook output stays JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-everyday-"));
    try {
      run(dir, ["add", "The deploy target is fly.io for production", "--title", "Deploy target"]);
      const r = run(dir, ["relevant", "where do we deploy"]);
      assert.match(r.stdout, /#1 \[default\] Deploy target/);
      assert.match(r.stdout, /The deploy target is fly\.io/);
      const h = run(dir, ["search", "--help"]);
      assert.equal(h.status, 0);
      assert.match(h.stdout, /--namespace/);
      assert.match(h.stdout, /--as-of/);
      assert.match(h.stdout, /--mode keyword\|semantic\|hybrid/);
      const hook = run(dir, ["recall"]);
      assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.hookEventName, "SessionStart", "piped output (the hook) is unchanged JSON");
      const txt = run(dir, ["recall", "--text"]);
      assert.ok(!txt.stdout.trim().startsWith("{"), txt.stdout);
      assert.match(txt.stdout, /Deploy target/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("semantic search without an embedding service says so; keyword results are unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-everyday-"));
    try {
      run(dir, ["add", "zebra crossing notes", "--title", "Zebra"]);
      const plain = run(dir, ["search", "zebra", "--mode", "keyword"]);
      assert.ok(!/semantic search is not set up/.test(plain.stdout));
      const sem = run(dir, ["search", "zebra", "--mode", "semantic"]);
      assert.match(sem.stdout, /semantic search is not set up; showing keyword results/);
      assert.match(sem.stdout, /#1 \[default\] Zebra/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
