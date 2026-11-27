// "Forget that actually forgets": after a hard delete (store.delete: the person's delete) no file in the data folder may still
// hold the note's text: not the database, its write-ahead log, nor any side file. Archive is NOT forgetting (it keeps the row
// by design), so it is asserted to keep the text, and the test names that difference.
import "./setup-env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";

const SECRET = "zqxforgetmarker8841";
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)).map((x) => join(f, x)) : [f]));
const holding = (dir: string): string[] => filesUnder(dir).filter((f) => readFileSync(join(dir, f)).includes(SECRET));

describe("forget: hard delete leaves the text in no file", () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monomem-forget-"));
    store = new Store(join(dir, "state.db"));
  });
  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("delete after search, edit and read removes the text from the database and the log", () => {
    const n = store.create({ title: `title ${SECRET}`, body: `body ${SECRET} with enough words to be indexed by the search table` });
    store.search(SECRET);
    store.update(n.id, { body: `second version ${SECRET} words words words` });
    store.read(n.id, { trackAccess: true });
    assert.ok(holding(dir).length > 0, "sanity: the text is on disk before the delete");
    assert.equal(store.delete(n.id), true);
    assert.deepEqual(holding(dir), []);
  });

  test("archive keeps the text on purpose (undoable); only delete forgets", () => {
    const n = store.create({ title: `t ${SECRET}`, body: `body ${SECRET} words words words words` });
    store.archive(n.id);
    assert.ok(holding(dir).length > 0);
  });
});
