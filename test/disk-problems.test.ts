// r8: a full disk or a read-only database must say so in plain words (MCP tool result and REST), not "internal error".
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { errorFor } from "../src/mcp/shared.js";
import { diskProblem } from "../src/restore.js";

const text = (r: { content: Array<{ text: string }> }): string => r.content[0].text;

test("a full database file: the write fails, nothing earlier is lost, the tool result says the disk is full", () => {
  const s = new Store(":memory:", { bodyIndex: "off" });
  for (let i = 0; i < 20; i++) s.create({ title: `a${i}`, body: "before the disk filled " + "x".repeat(400) }, { bulkImport: true });
  const pages = Number((s.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
  s.db.exec(`PRAGMA max_page_count = ${pages + 2}`);
  let err: unknown;
  for (let i = 0; i < 100 && !err; i++) {
    try { s.create({ title: `f${i}`, body: "fill " + "y".repeat(3000) }, { bulkImport: true }); } catch (e) { err = e; }
  }
  assert.ok(err, "the write must fail once the file cannot grow");
  assert.equal(diskProblem(err)?.kind, "full");
  const r = errorFor(err);
  assert.match(text(r as never), /disk is full.*nothing was saved/i);
  assert.doesNotMatch(text(r as never), /internal error/);
  s.db.exec("PRAGMA max_page_count = 1073741823");
  assert.equal(s.list({ limit: 5 }).notes.length > 0, true);
  s.create({ title: "after", body: "writes work again when space is back" }, { bulkImport: true });
});

test("diskProblem recognises full and read-only by code or wording and nothing else", () => {
  assert.equal(diskProblem(Object.assign(new Error("x"), { errcode: 13 }))?.kind, "full");
  assert.equal(diskProblem(new Error("database or disk is full"))?.kind, "full");
  assert.equal(diskProblem(new Error("ENOSPC: no space left on device"))?.kind, "full");
  assert.equal(diskProblem(Object.assign(new Error("attempt to write a readonly database"), { errcode: 8 }))?.kind, "readonly");
  assert.equal(diskProblem(new Error("database is locked")), null);
  assert.equal(diskProblem(new Error("boom")), null);
});
