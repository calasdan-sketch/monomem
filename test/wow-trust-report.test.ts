import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { runBench } from "../src/bench/index.js";
import { renderTrustReport, readStoreFacts, readmeLimitLines, countTestFiles, esc, type TrustInput } from "../src/trust-report.js";

const XSS = `<script>alert(1)</script>`;

describe("monomem report", () => {
  test("every number in the report is computed from the real bench report and the store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wow-report-"));
    try {
      const db = join(dir, "t.db");
      const s = new Store(db);
      s.create({ title: "a", body: "b" });
      s.recordWriterEvent("claude-code", "rolled_back", 1);
      s.recordWriterEvent("claude-code", "rejected", null as never);
      s.recordWriterEvent(XSS, "held_approved", 1);
      s.close();
      const { report } = await runBench({ suites: ["stale"] });
      const input: TrustInput = { version: "9.9.9", date: "2026-11-24", node: "v0", platform: "test", bench: report, drill: { attacks: 27, held: 8, blocked: 13, warned: 4, reached: 2, known_misses: ["E16 reworded override"] }, store: readStoreFacts(db), testFiles: 12, readmeLimits: ["The write check is pattern matching."] };
      const html = renderTrustReport(input);
      assert.match(html, new RegExp(`${report.summary.scenarios} scenarios, ${report.summary.checks} checks`));
      assert.match(html, /27 known attacks replayed[^<]*8 held, 13 blocked, 4 warned, <b>2 reached memory<\/b>/);
      assert.match(html, /12 test files/);
      assert.match(html, /The write check is pattern matching\./);
      for (const l of report.limits) assert.ok(html.includes(esc(l)), "benchmark limit missing");
      assert.match(html, /<td>claude-code<\/td><td>0<\/td><td>0<\/td><td>1<\/td><td>1<\/td>/);
      assert.ok(!/<script/i.test(html), "a writer name reached the page as markup");
      assert.ok(html.includes("&lt;script&gt;"));
      assert.ok(!/<img|<link|src=|href=/i.test(html), "one self-contained file");
      assert.match(html, /Not independently reviewed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("known gaps come from the benchmark, not from the report code", async () => {
    const { report } = await runBench({ suites: ["poison"] });
    const html = renderTrustReport({ version: "1", date: "d", node: "n", platform: "p", bench: report, drill: null, store: null, testFiles: null, readmeLimits: [] });
    for (const g of report.known_gaps) assert.ok(html.includes(esc(g.id)), g.id);
    assert.match(html, /attack replay was not run/);
    assert.match(html, /No store was found/);
    assert.match(html, /not part of the npm package/);
  });

  test("README limits are read from the file's own bullets; a missing file gives none", () => {
    const readme = "intro\n\n**What it does not do.** Please read:\n\n- First [link](./x.md) limit.\n- Second `code` limit.\n\nNext section\n- not this";
    assert.deepEqual(readmeLimitLines(readme), ["First link limit.", "Second code limit."]);
    assert.deepEqual(readmeLimitLines("nothing"), []);
    assert.equal(countTestFiles(null), null);
    const dir = mkdtempSync(join(tmpdir(), "wow-tf-"));
    try {
      mkdirSync(join(dir, "test"));
      writeFileSync(join(dir, "test", "a.test.ts"), "");
      writeFileSync(join(dir, "test", "b.txt"), "");
      assert.equal(countTestFiles(dir), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing store gives no facts", () => {
    assert.equal(readStoreFacts(join(tmpdir(), "does-not-exist-wow.db")), null);
  });
});
