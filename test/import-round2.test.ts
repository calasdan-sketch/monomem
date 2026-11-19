// Round 2 import fixes: no trust marks from a file that is not signed, a clear warning when notes have no `body`,
// and a headline that is not plain success when every body is empty.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";
import { Store, type ImportReport } from "../src/store.js";
import { stripImportTrust, describeTrustStripped } from "../src/import-trust.js";
import { ImportShape, importHeadline } from "../src/import-report.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const run = (args: string[], dataDir: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", MONOMEM_HOME: dataDir, MONOMEM_DB_PATH: join(dataDir, "state.db"), MONOMEM_AUTO_SCOPE: "" },
  });

describe("an unsigned import file cannot bring trust marks", () => {
  test("stripImportTrust removes reviewed / confirmed / pinned tags and fields and the revision number", () => {
    const report: { trustStripped?: { notes: number; marks: Record<string, number> } } = {};
    const note = { title: "x", tags: ["Reviewed", "keep", "pinned"], rev: 40, confirmed: true, pinned: true };
    const clean = stripImportTrust(note, report);
    assert.deepEqual(clean.tags, ["keep"]);
    assert.equal((clean as { rev?: number }).rev, undefined);
    assert.equal((clean as { pinned?: boolean }).pinned, undefined);
    assert.equal(note.rev, 40, "the original is not changed");
  // A plain backup note that only has an edit count keeps it (restores keep history).
  const plainRev = { title: "y", tags: ["topic"], rev: 12 };
  assert.equal(stripImportTrust(plainRev), plainRev);
    assert.equal(report.trustStripped?.notes, 1);
    assert.match(describeTrustStripped(report.trustStripped), /no verified signature.*removed.*review queue/s);
    const plain = { title: "y", tags: ["a"] };
    assert.equal(stripImportTrust(plain, report), plain, "a note with no marks is returned as it is");
  });

  test("importNotes stores such a note without the marks and says so in the report", async () => {
    const s = new Store(":memory:");
    const report: ImportReport = { quarantined: [], rejected: [] };
    const made = await s.importNotes([{ title: "from a hand-made file", body: "text", tags: ["reviewed", "pinned", "topic"], rev: 25 } as never], { report });
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].tags, ["topic"]);
    assert.equal(made[0].rev, 1, "starts at revision 1, not the file's 25");
    assert.equal(report.trustStripped?.notes, 1);
    s.close();
  });
});

describe("notes with no body", () => {
  test("ImportShape names the field they have instead", () => {
    const shape = new ImportShape();
    shape.observe({ title: "a", content: "words" });
    shape.observe({ title: "b", content: "more words" });
    assert.equal(shape.empty, 2);
    assert.equal(shape.allEmpty, true);
    assert.match(shape.warnings()[0], /2 of 2 notes have no "body" text.*"content" instead.*"body"/s);
    assert.match(importHeadline(2, 0, shape), /WARNING: every one has an empty body/);
    const ok = new ImportShape();
    ok.observe({ title: "a", body: "text" });
    assert.equal(importHeadline(1, 0, ok), "Imported 1 note(s).");
  });

  test("monomem import --file with `content` instead of `body` warns and does not read as plain success", () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-import2-"));
    const file = join(dir, "notes.json");
    writeFileSync(file, JSON.stringify({ notes: [{ title: "one", content: "text one" }, { title: "two", content: "text two" }] }));
    const r = run(["import", "--file", file], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /WARNING: every one has an empty body/);
    assert.match(r.stdout, /2 of 2 notes have no "body" text/);
    assert.match(r.stdout, /"content" instead/);
  });

  test("a normal file imports with the plain success line and no warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-import2-"));
    const file = join(dir, "notes.json");
    writeFileSync(file, JSON.stringify({ notes: [{ title: "one", body: "text one" }] }));
    const r = run(["import", "--file", file], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Imported 1 note\(s\)\./);
    assert.doesNotMatch(r.stdout, /WARNING|no "body"/);
  });
});
