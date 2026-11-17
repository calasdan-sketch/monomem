// `monomem tasks` (PLAN I, r3 release gate "monomem tasks"): list / show / done / handoff over the task store.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { putTask, getTask, listHandoffs } from "../src/tasks.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const run = (dir: string, args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "t.db") }, encoding: "utf8" });

test("monomem tasks: quiet open list (overdue first, safe text), show, done, handoff read and write", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-tasks-"));
  try {
    const s = new Store(join(dir, "t.db"));
    const a = putTask(s, { title: "Write the release notes", status: "planned", next_step: "draft the summary", owner: "codex" }).task;
    const b = putTask(s, { title: "Old overdue job", status: "running", due: "2020-01-01" }).task;
    const c = putTask(s, { title: "Finished already", status: "done" }).task;
    s.close();

    const empty = run(dir, ["tasks", "--status", "failed"]);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(empty.stdout.trim(), "No open tasks.");

    const ls = run(dir, ["tasks"]);
    assert.equal(ls.status, 0, ls.stderr);
    const lines = ls.stdout.trim().split("\n");
    assert.equal(lines.length, 2, ls.stdout);
    assert.match(lines[0], new RegExp(`^#${b.id} \\[running\\] Old overdue job, overdue since 2020-01-01$`));
    assert.match(lines[1], new RegExp(`^#${a.id} \\[planned\\] Write the release notes: next draft the summary, codex$`));
    assert.ok(!ls.stdout.includes("Finished already"), "done tasks are left out by default");
    assert.match(run(dir, ["tasks", "list", "--all"]).stdout, /Finished already/);
    assert.equal(JSON.parse(run(dir, ["tasks", "--json"]).stdout).total, 2);

    const show = run(dir, ["tasks", "show", String(a.id)]);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Status: planned\nOwner: codex\nNext step: draft the summary/);
    assert.notEqual(run(dir, ["tasks", "show", "999"]).status, 0);

    const done = run(dir, ["tasks", "done", `#${a.id}`]);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /is done\./);
    assert.match(run(dir, ["tasks", "done", String(c.id)]).stdout, /already done/);
    const s2 = new Store(join(dir, "t.db"));
    try {
      assert.equal(getTask(s2, a.id).status, "done");
    } finally { s2.close(); }

    assert.match(run(dir, ["tasks", "handoff"]).stdout, /No handoff yet/);
    const w = run(dir, ["tasks", "handoff", "Shipped the docs", "--next", "tag the release", "--pending", "changelog;screenshots"]);
    assert.equal(w.status, 0, w.stderr);
    const h = run(dir, ["tasks", "handoff"]);
    assert.match(h.stdout, /from cli/);
    assert.match(h.stdout, /Shipped the docs\n  Next step: tag the release\n  Pending: changelog; screenshots/);
    const s3 = new Store(join(dir, "t.db"));
    try {
      assert.equal(listHandoffs(s3)[0].written_by, "cli");
    } finally { s3.close(); }

    assert.notEqual(run(dir, ["tasks", "frobnicate"]).status, 0);
    assert.match(run(dir, ["tasks", "--help"]).stdout, /show <id>/);
    assert.match(run(dir, ["tasks", "help"]).stdout, /tasks show <id>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("monomem tasks: a title with terminal escapes prints as plain text", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-tasks-esc-"));
  try {
    const s = new Store(join(dir, "t.db"));
    // putTask drops control characters from titles already; write the note directly to test the printing path itself.
    s.create({ title: "Evil \u001b[2Jtitle", body: "", tags: ["task", "status:planned"] });
    s.close();
    const ls = run(dir, ["tasks"]);
    assert.equal(ls.status, 0, ls.stderr);
    assert.ok(!ls.stdout.includes("\u001b"), JSON.stringify(ls.stdout));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
