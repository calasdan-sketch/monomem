// 1.5.0 R1-03: the confirm rules are checked inside the write transaction, so two processes cannot both pass them.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";

const ROUNDS = 20;
const SRC = pathToFileURL(join(process.cwd(), "dist", "src")).href;

// Each child confirms every note at the same wall-clock slot as its sibling (a busy-wait barrier), so the two processes
// race through confirmRefusal and the insert.
const CHILD = `
import { Store } from "${SRC}/store.js";
import { actorStore } from "${SRC}/actor.js";
const [db, label, source, t0, first, count] = process.argv.slice(2);
const s = new Store(db);
for (let i = 0; i < Number(count); i++) {
  const slot = Number(t0) + i * 40;
  while (Date.now() < slot) { /* barrier */ }
  actorStore.run({ label, authed: true }, () => s.confirm(Number(first) + i, { source }));
}
s.close();
`;

function runChild(dir: string, db: string, label: string, source: string, t0: number, first: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(dir, "child.mjs"), db, label, source, String(t0), String(first), String(ROUNDS)], { env: { ...process.env, MONOMEM_HOME: dir }, stdio: "ignore" });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`child ${label} exited ${c}`))));
  });
}

function counted(db: string, id: number): number {
  const d = new DatabaseSync(db);
  try {
    return Number((d.prepare("SELECT COUNT(*) AS c FROM confirmations WHERE note_id = ? AND reason = ''").get(id) as { c: number }).c);
  } finally {
    d.close();
  }
}

describe("R1-03 confirm rules run inside the write transaction", () => {
  test("two processes: the same writer confirming one version counts once; two corroborators naming one source count once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-confirm-race-"));
    try {
      const db = join(dir, "state.db");
      writeFileSync(join(dir, "child.mjs"), CHILD);
      const s = new Store(db);
      setProcessWriter("stdio:bot");
      const a: number[] = [];
      const b: number[] = [];
      for (let i = 0; i < ROUNDS; i++) a.push(s.create({ title: `a${i}`, body: "x", outside: true }).id);
      for (let i = 0; i < ROUNDS; i++) b.push(s.create({ title: `b${i}`, body: "x", outside: true }).id);
      s.close();
      const t0 = Date.now() + 1500;
      await Promise.all([runChild(dir, db, "tokA", "src one", t0, a[0]), runChild(dir, db, "tokA", "src two", t0, a[0])]);
      const t1 = Date.now() + 1500;
      await Promise.all([runChild(dir, db, "tokB", "same source", t1, b[0]), runChild(dir, db, "tokC", "same source", t1, b[0])]);
      for (const id of a) assert.equal(counted(db, id), 1, `note ${id}: one counted confirm per writer per version`);
      for (const id of b) assert.equal(counted(db, id), 1, `note ${id}: one counted confirm per source`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
