import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { historyWithDiffs, renderHistoryDiff, historyDiffCli } from "../src/history-diff.js";

const ADMIN = { scope: "admin" } as const;

function withStore(fn: (s: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "wow-hist-"));
  const s = new Store(join(dir, "t.db"));
  try {
    fn(s);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("history with a diff", () => {
  test("each earlier version is diffed against the text that replaced it", () => {
    withStore((s) => {
      const n = s.create({ title: "port", body: "staging is 8443" });
      s.update(n.id, { body: "staging is 9000" });
      s.update(n.id, { body: "staging is 9000\nand has TLS" });
      const h = historyWithDiffs(s, ADMIN, n.id);
      assert.equal(h.current.version, 3);
      assert.equal(h.versions.length, 2);
      assert.ok(h.versions[0].diff.some((l) => l === "+ and has TLS"), h.versions[0].diff.join("|")); // v2 -> now
      assert.ok(h.versions[1].diff.includes("- staging is 8443") && h.versions[1].diff.includes("+ staging is 9000")); // v1 -> v2
    });
  });

  test("a note with no earlier version says so; a non-admin is refused", () => {
    withStore((s) => {
      const n = s.create({ title: "t", body: "b" });
      assert.deepEqual(renderHistoryDiff(historyWithDiffs(s, ADMIN, n.id)).slice(1), ["No earlier versions are kept."]);
      assert.throws(() => historyWithDiffs(s, { scope: "write" }, n.id), /administrators/);
    });
  });

  test("terminal output neutralises control characters in old text", () => {
    withStore((s) => {
      const n = s.create({ title: "t", body: "line \u001b[31mred\u001b[0m" });
      s.update(n.id, { body: "plain" });
      const lines: string[] = [];
      historyDiffCli(s, ADMIN, n.id, false, false, (l) => lines.push(l));
      assert.ok(!lines.join("\n").includes("\u001b"), "escape sequence reached the terminal");
      assert.ok(lines.some((l) => l.includes("- ")));
    });
  });

  test("--json prints the same rows", () => {
    withStore((s) => {
      const n = s.create({ title: "t", body: "one" });
      s.update(n.id, { body: "two" });
      const lines: string[] = [];
      historyDiffCli(s, ADMIN, n.id, false, true, (l) => lines.push(l));
      const j = JSON.parse(lines.join("\n"));
      assert.equal(j.versions.length, 1);
      assert.deepEqual(j.versions[0].diff.slice(-2), ["- one", "+ two"]);
    });
  });
});
