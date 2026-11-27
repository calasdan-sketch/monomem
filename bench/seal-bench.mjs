// Seal + ledger cost (schema v23). Run after `npm run build`:  node bench/seal-bench.mjs [notes=100000] [writes=3000]
//  1. write cost: create + update with the seal triggers on, and with them dropped (no dirty rows, so nothing to seal or log)
//  2. upgrade cost: a v22-shaped store of N notes opened by this build (time to first use, time to finish sealing), then doctor's check
// Uses a throwaway folder (MONOMEM_HOME); never touches a real store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(process.env.MONOMEM_BENCH_DIR ?? tmpdir(), "monomem-sealbench-"));
process.env.MONOMEM_HOME = process.env.ONEMEMORY_HOME = root;
process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "0";
const dist = pathToFileURL(join(import.meta.dirname, "..", "dist", "src")).href;
const { Store } = await import(`${dist}/store.js`);
const { verifyAll } = await import(`${dist}/store/integrity.js`);
const { backfillFor } = await import(`${dist}/store/ledger.js`);
const N = Number(process.argv[2] ?? 100000);
const W = Number(process.argv[3] ?? 3000);
const us = (ms, n) => Math.round((ms * 1000) / n);
const body = "x".repeat(400);

function writeCost(label, dropTriggers) {
  const dir = mkdtempSync(join(root, "w-"));
  const s = new Store(join(dir, "state.db"));
  if (dropTriggers) s.db.exec("DROP TRIGGER notes_seal_ai; DROP TRIGGER notes_seal_au; DROP TRIGGER notes_seal_ad;");
  const ids = [];
  let t = performance.now();
  for (let i = 0; i < W; i++) ids.push(s.create({ title: `note ${i}`, body: `${body} ${i}` }).id);
  const create = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < W; i++) s.update(ids[i], { body: `${body} edited ${i}` });
  const update = performance.now() - t;
  console.log(`${label.padEnd(26)} create ${us(create, W)} us/op   update ${us(update, W)} us/op`);
  s.close();
}
writeCost("seal off (triggers dropped)", true);
writeCost("seal + ledger on", false);

// upgrade of a big v22-shaped store
const dir = mkdtempSync(join(root, "big-"));
const dbPath = join(dir, "state.db");
{
  const s = new Store(dbPath);
  s.create({ title: "first", body: "x" });
  s.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("DROP TRIGGER notes_seal_ai; DROP TRIGGER notes_seal_au; DROP TRIGGER notes_seal_ad; DROP TABLE seal_dirty; DROP TABLE ledger; ALTER TABLE notes DROP COLUMN seal; DELETE FROM _meta WHERE key LIKE 'seal_%'");
  raw.exec("BEGIN");
  const ins = raw.prepare("INSERT INTO notes (title, body, created_at, updated_at, written_by, created_by) VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'bench', 'bench')");
  for (let i = 0; i < N; i++) ins.run(`bulk ${i}`, `${body} ${i}`);
  raw.exec("COMMIT; PRAGMA user_version = 22");
  raw.close();
}
let t = performance.now();
const u = new Store(dbPath);
const open = performance.now() - t;
const done0 = verifyAll(u).backfillDone;
t = performance.now();
backfillFor(u, 3_600_000);
const rest = performance.now() - t;
t = performance.now();
const rep = verifyAll(u);
const check = performance.now() - t;
t = performance.now();
const full = verifyAll(u, { signatures: true });
const fullMs = performance.now() - t;
console.log(`v22 -> v23 with ${N} notes: first open (migration + first slice) ${Math.round(open)} ms (sealing finished at open: ${done0}); rest of the sealing ${Math.round(rest)} ms`);
console.log(`doctor check (fast): ${Math.round(check)} ms, ${rep.notes} notes, ${rep.ledgerEntries} ledger entries, failures ${rep.issues.filter((i) => i.severity === "fail").length}; with signatures: ${Math.round(fullMs)} ms`);
u.close();
rmSync(root, { recursive: true, force: true });
