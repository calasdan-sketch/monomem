// 1.6 command names: check / review <part> / activity / tidy <job> / keys / settings / replace turn into the command
// that does the work; every old name still works and, at a terminal only, names its new form on stderr.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";
import { translateVerb, oldNameNote, OLD_COMMANDS } from "../src/cli/verbs.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

describe("translateVerb", () => {
  test("each new word becomes the command that does the work", () => {
    const cases: Array<[string[], string[] | null]> = [
      [["check"], ["health"]],
      [["check", "--json"], ["health", "--json"]],
      [["check", "--setup"], ["doctor"]],
      [["check", "--attacks", "--json"], ["drill", "--json"]],
      [["check", "--usage"], ["meter"]],
      [["check", "--report", "--out", "r.html"], ["safety-report", "--out", "r.html"]],
      [["review", "held", "approve", "3"], ["quarantine", "approve", "3"]],
      [["review", "code", "--json"], ["stale", "--code", "--json"]],
      [["review", "duplicates"], ["quality"]],
      [["review", "keep", "4"], null],
      [["review"], null],
      [["activity", "--since", "2h"], ["changes", "--since", "2h"]],
      [["activity", "--follow"], ["watch"]],
      [["activity", "--writes"], ["audit", "--since", "24h"]],
      [["tidy", "merge", "--dry-run"], ["consolidate", "--dry-run"]],
      [["tidy"], ["tidy"]],
      [["keys", "list"], ["token", "list"]],
      [["settings", "get"], ["config", "get"]],
      [["replace", "undo", "3"], ["supersede", "undo", "3"]],
      [["add", "x"], null],
    ];
    for (const [i, o] of cases) assert.deepEqual(translateVerb(i), o, i.join(" "));
  });

  test("old names get a one-line pointer to the new form; new names and unrenamed commands get none", () => {
    assert.match(oldNameNote("quarantine")!, /monomem review held/);
    assert.match(oldNameNote("stale", "--code")!, /review code/);
    for (const c of ["check", "review", "add", "history", "archive"]) assert.equal(oldNameNote(c), null, c);
  });
});

describe("the command line", () => {
  test("help is the short list of new words, about 30 commands; help --all still has every old name", () => {
    const short = run(["help"]).stdout;
    const verbs = new Set([...short.matchAll(/^ {2}([a-z][a-z-]*)/gm)].map((m) => m[1]));
    assert.ok(verbs.size <= 32, `${verbs.size} commands in the short help: ${[...verbs].join(" ")}`);
    for (const v of ["check", "review", "activity", "tidy", "keys", "settings", "replace", "archive"]) assert.ok(verbs.has(v), v);
    for (const old of ["doctor", "health", "quarantine", "quality", "changes", "token", "config", "supersede", "consolidate"]) assert.ok(!verbs.has(old), old);
    const all = run(["help", "--all"]).stdout;
    for (const old of Object.keys(OLD_COMMANDS)) assert.ok(all.includes(old), old);
    assert.match(run(["help", "check"]).stdout, /--setup/);
  });

  test("an old name works exactly as before when piped: same stdout, nothing extra on stderr", () => {
    const a = run(["token", "list"]);
    const b = run(["keys", "list"]);
    assert.equal(a.stdout, b.stdout);
    assert.equal(a.status, b.status);
    assert.doesNotMatch(a.stderr, /is now/);
  });

  test("help no longer says start is the default", () => {
    assert.doesNotMatch(run(["help", "--all"]).stdout, /start.{0,40}\(the default\)/);
    assert.doesNotMatch(run(["help", "--all"]).stdout, /each running this node with this cli\.js/);
  });

  test("tidy with no job lists the jobs", () => {
    const r = run(["tidy"]);
    assert.equal(r.status, 0);
    for (const j of ["merge", "edges", "reindex", "decay", "scrub"]) assert.ok(r.stdout.includes(`  ${j}`), j);
  });
});
