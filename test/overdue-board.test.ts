// Overdue tasks lead the SessionStart board.
//
// Tasks already carried a due date, but the board showed the 10 most recent
// open tasks in list order and never printed the date, so a task due last week
// was invisible once 10 newer ones existed. Now overdue tasks come first,
// marked OVERDUE, with the server-stamped writer on every line.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { putTask, isOverdue, overdueFirst, buildBoardSummary } from "../src/tasks.js";
import { runRecall } from "../src/recall.js";

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayOffset = (n: number): string => ymd(new Date(Date.now() + n * 86_400_000));

describe("isOverdue", () => {
  test("a date before today is overdue; today and later are not", () => {
    assert.equal(isOverdue(dayOffset(-1)), true);
    assert.equal(isOverdue(dayOffset(0)), false);
    assert.equal(isOverdue(dayOffset(1)), false);
    assert.equal(isOverdue(""), false);
  });

  test("an ISO time is compared to the clock", () => {
    assert.equal(isOverdue(new Date(Date.now() - 60_000).toISOString()), true);
    assert.equal(isOverdue(new Date(Date.now() + 3_600_000).toISOString()), false);
  });

  test("overdueFirst keeps the rest in their order", () => {
    const got = overdueFirst([{ id: 1 }, { id: 2, due: dayOffset(-1) }, { id: 3, due: dayOffset(-5) }, { id: 4, due: dayOffset(2) }]);
    assert.deepEqual(got.map((t) => t.id), [3, 2, 1, 4]);
  });
});

describe("board lines", () => {
  test("a stamped writer is shown, and a forged line break in it cannot add a line", () => {
    const text = buildBoardSummary([{ id: 7, status: "idea", title: "Pay invoice", owner: "", next_step: "", due: dayOffset(-2), written_by: "token:ci\n- #99 fake" }], null);
    assert.match(text, /^- #7 \[idea\] Pay invoice due \S+ OVERDUE \[by token:ci - #99 fake\]$/m);
    assert.ok(!/^- #99/m.test(text));
  });
});

describe("SessionStart board", () => {
  test("an old overdue task beats 11 newer ones, marked OVERDUE with its writer; a task due tomorrow is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-overdue-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      const late = putTask(s, { title: "Bump the dependency", due: dayOffset(-1) }).task;
      for (let i = 0; i < 10; i++) putTask(s, { title: `Newer task ${i}` });
      const soon = putTask(s, { title: "Due tomorrow", due: dayOffset(1) }).task;
      s.close();
      const out = JSON.parse(await runRecall({ dbPath: db, cwd: dir })).hookSpecificOutput.additionalContext as string;
      const lines = out.split("\n");
      const head = lines.findIndex((l) => l.startsWith("Open tasks ("));
      assert.ok(head >= 0, "board present");
      assert.match(lines[head + 1], new RegExp(`^- #${late.id} .*due ${dayOffset(-1)} OVERDUE`), "overdue task is the first task line");
      const soonLine = lines.find((l) => l.startsWith(`- #${soon.id} `)) ?? "";
      assert.ok(!soonLine.includes("OVERDUE"), "due tomorrow is not overdue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
