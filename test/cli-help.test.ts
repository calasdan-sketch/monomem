// First-impression CLI behaviour: short grouped help, a helpful unknown-command message, old-Node workaround.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

describe("cli help", () => {
  test("default help is short and grouped; --all keeps the full text", () => {
    const short = run(["help"]).stdout;
    for (const g of ["Get started", "Daily", "Trust", "Maintenance"]) assert.match(short, new RegExp(g));
    assert.match(short, /help --all/);
    assert.doesNotMatch(short, /rebuild-edges/);
    assert.match(run(["help", "--all"]).stdout, /rebuild-edges/);
  });
  test("--help and -h are the general help; ls --help and help ls show ls's real line; hook --help prints help and runs no hook", () => {
    const general = run(["help"]).stdout;
    assert.equal(run(["--help"]).stdout, general);
    assert.equal(run(["-h"]).stdout, general);
    for (const args of [["ls", "--help"], ["help", "ls"]]) {
      const r = run(args);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^monomem ls\n\n {2}show <id> \| ls \[--ns x\]/, args.join(" "));
    }
    for (const c of ["edit", "forget", "unpin"]) assert.doesNotMatch(run([c, "--help"]).stdout, /no extra options/, c);
    assert.equal(run(["help", "nosuchcmd"]).stdout, general, "an unknown word falls back to the general help");
    const hook = spawnSync(process.execPath, [CLI, "hook", "--help"], { encoding: "utf8", input: "", env: { ...process.env, NO_COLOR: "1" } });
    assert.equal(hook.status, 0);
    assert.match(hook.stdout, /hook <session-start\|.*file-context>/);
    assert.doesNotMatch(hook.stdout, /hookSpecificOutput/);
    assert.match(run(["export", "--help"]).stdout, /the plain \{"notes": \[\.\.\.\]\} shape older importers read/);
  });
  test("an unknown command suggests the closest one and exits non-zero without dumping help", () => {
    const r = run(["stat"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command 'stat'\. Did you mean 'start'\?/);
    assert.match(r.stderr, /monomem help/);
    assert.equal(r.stdout, "");
    assert.match(run(["doctr"]).stderr, /Did you mean 'doctor'\?/);
    assert.doesNotMatch(run(["xyzxyzxyz"]).stderr, /Did you mean/);
  });
  test("old Node gets the one-line workaround", () => {
    const root = mkdtempSync(join(tmpdir(), "om-clihelp-"));
    try {
      const shim = join(root, "shim.mjs");
      writeFileSync(shim, `Object.defineProperty(process.versions, "node", { value: "22.1.0" });\nawait import(${JSON.stringify("file://" + CLI.replace(/\\/g, "/"))});\n`);
      const r = spawnSync(process.execPath, [shim, "setup", "--dry-run"], { encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root, MONOMEM_HOME: join(root, "om") } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /npx -y -p node@24 -p monomem monomem setup/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("every command main() handles is on the known-command list (no 'Unknown command' for a real one)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(PROJECT_ROOT, "src", "cli.ts"), "utf8");
  const listed = src.slice(src.indexOf("const COMMANDS = ["), src.indexOf("];", src.indexOf("const COMMANDS = [")));
  const cases = [...src.matchAll(/^ {4}case "([a-z][a-z:-]*)":/gm)].map((m) => m[1]); // the top-level switch only
  const missing = [...new Set(cases)].filter((c) => !listed.includes(`"${c}"`));
  assert.deepEqual(missing, []);
});

test("help --all mentions every real command (aliases and flags excepted)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(PROJECT_ROOT, "src", "cli.ts"), "utf8");
  const start = src.indexOf("const COMMANDS = [");
  const listed = [...src.slice(start, src.indexOf("];", start)).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const aliases = new Set(["serve", "mcp:stdio", "version", "help", "--help", "-h", "--version", "-v"]);
  const all = run(["help", "--all"]).stdout;
  const words = new Set(all.split(/[^A-Za-z0-9:-]+/));
  const missing = listed.filter((c) => !aliases.has(c) && !words.has(c));
  assert.deepEqual(missing, []);
});
