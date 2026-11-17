// setup-env gives every test process its own temp root. Without it, test files running in parallel processes share
// os.tmpdir(): r2-fixsec's drill test counted another file's monomem-drill-* copies (release gate SF-1), and folders a
// test forgot to remove (om-142-*) piled up in the real temp folder.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SETUP = pathToFileURL(join(process.cwd(), "dist/test/setup-env.js")).href;
// A second test process that leaves a drill copy and a stray folder in its temp folder and exits.
const SIBLING = `const os=require("os"),fs=require("fs"),p=require("path");
for (const pre of ["monomem-drill-","om-142-leak-"]) console.log(fs.mkdtempSync(p.join(os.tmpdir(),pre)));`;

test("another test process's temp folders never show up in this process's tmpdir, and are gone when it exits", () => {
  const drills = (): number => readdirSync(tmpdir()).filter((f) => f.startsWith("monomem-drill-")).length;
  const before = drills();
  const r = spawnSync(process.execPath, ["--import", SETUP, "-e", SIBLING], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, r.stderr);
  const made = r.stdout.trim().split(/\r?\n/);
  assert.equal(made.length, 2, r.stdout);
  try {
    assert.equal(drills(), before, "the sibling's monomem-drill-* folder landed in this process's temp folder");
    for (const d of made) assert.equal(existsSync(d), false, `left behind after the process exited: ${d}`);
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
});

test("this process's temp root is a private monomem-test-tmp-* folder", () => {
  assert.match(tmpdir(), /monomem-test-tmp-/);
  assert.equal(process.env.TMP, tmpdir());
  assert.equal(process.env.TEMP, tmpdir());
  assert.equal(process.env.TMPDIR, tmpdir());
});
