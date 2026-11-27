// Round-4 QA regressions found by driving the real CLI as a new user: a new store is not "checked by an older linter",
// a mistyped tidy job / import source / key scope says so, and file-system errors are said in plain words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeFsError } from "../src/cli/fs-errors.js";
import { tidyHelpFor } from "../src/cli/verbs.js";

const cli = join(process.cwd(), "dist", "src", "cli.js");
function run(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, MONOMEM_HOME: join(home, "mm"), ONEMEMORY_HOME: join(home, "om"), MONOMEM_AUDIT_LOG: join(home, "audit.log"), HOME: home, USERPROFILE: home },
    encoding: "utf8",
    cwd: home,
    input: "",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a brand-new store is not told its notes were checked by an older linter", () => {
  const home = mkdtempSync(join(tmpdir(), "qa-r4-"));
  assert.equal(run(home, "add", "hello world", "--title", "hi").code, 0);
  assert.ok(existsSync(join(home, "mm", "lint-scan.json")), "the marker is written when the store is created");
  assert.match(readFileSync(join(home, "mm", "lint-scan.json"), "utf8"), /scanned_version/);
  const c = run(home, "check", "--setup");
  assert.doesNotMatch(c.out, /older memory linter/);
});

test("an existing store without a marker still gets the once-only rescan note", () => {
  const home = mkdtempSync(join(tmpdir(), "qa-r4-"));
  run(home, "add", "hello world", "--title", "hi");
  writeFileSync(join(home, "mm", "lint-scan.json"), "");
  // an empty marker file is unreadable, so it counts as "never scanned"
  assert.match(run(home, "check", "--setup").out, /older memory linter/);
});

test("tidy with a job that does not exist says so and exits 1; no job lists them and exits 0", () => {
  assert.equal(tidyHelpFor().code, 0);
  assert.equal(tidyHelpFor("--help").code, 0);
  const bad = tidyHelpFor("bogus");
  assert.equal(bad.code, 1);
  assert.match(bad.text, /Unknown tidy job 'bogus'/);
  const home = mkdtempSync(join(tmpdir(), "qa-r4-"));
  const r = run(home, "tidy", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.out, /Unknown tidy job 'bogus'/);
});

test("import --from with an unknown tool names it", () => {
  const home = mkdtempSync(join(tmpdir(), "qa-r4-"));
  const r = run(home, "import", "--from", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.out, /Unknown source 'bogus'/);
});

test("keys add with a scope that does not exist is a plain error, not an operator prompt", () => {
  const home = mkdtempSync(join(tmpdir(), "qa-r4-"));
  const r = run(home, "keys", "add", "x", "--scope", "bogus");
  assert.equal(r.code, 1);
  assert.match(r.out, /--scope must be read, write or admin/);
  assert.doesNotMatch(r.out, /Refused/);
});

test("file-system errors reach the user in plain words", () => {
  const e = Object.assign(new Error("EEXIST: file already exists, mkdir 'x'"), { code: "EEXIST" });
  const [msg, fix] = describeFsError(e, e.message);
  assert.match(msg, /not a folder/);
  assert.ok(fix);
  assert.deepEqual(describeFsError(new Error("boom"), "boom"), ["boom"]);
  const home = mkdtempSync(join(tmpdir(), "qa-r4-"));
  writeFileSync(join(home, "afile"), "x");
  run(home, "add", "a note", "--title", "t");
  const r = run(home, "export", "--format", "md", "--dir", join(home, "afile"));
  assert.equal(r.code, 1);
  assert.match(r.out, /not a folder|part of that path is a file/);
});

test("check does not cut the confirm-rules line in the middle of a word", () => {
  const home = mkdtempSync(join(tmpdir(), "qa-r4-"));
  const fx = join(process.cwd(), "test", "fixtures", "importers", "mem0-export.json");
  assert.equal(run(home, "import", "--auto", fx, "--yes").code, 0);
  const j = JSON.parse(run(home, "check", "--json", "--quick").out.replace(/^\[monomem\].*\n/gm, "")) as { checks: { id: string; text: string }[] };
  const text = j.checks.find((c) => c.id === "confirm")?.text ?? "";
  assert.match(text, /declared by the writer/);
  assert.doesNotMatch(text, /sessi;/);
});

test("commit-trail on outside a git repository says to cd into one, not a hook line", () => {
  const home = mkdtempSync(join(tmpdir(), "qa-r4-"));
  const r = run(home, "commit-trail", "on");
  assert.equal(r.code, 1);
  assert.match(r.out, /not inside a git repository/);
  assert.match(r.out, /Fix: run it inside a git repository/);
  assert.doesNotMatch(r.out, /the hook line/);
});
