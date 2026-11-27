// "Lossless", as an executable property (the definition is the header of src/store/integrity.ts, L1-L6): several real OS processes write
// random creates, blind updates, archives and restores to ONE store; one of them is killed with SIGKILL mid-run. Afterwards:
//   L1 every write a process was told "yes" to (its ack file) has a ledger entry, and its text is live or in the note's history;
//   L2-L4, L6 the ledger, seals and history all verify (verifyAll has no failure).
// L5 (round trip) is the last test. Runs about 6 seconds; MONOMEM_LOSSLESS_MS lengthens it for the nightly run.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { missingAcks, verifyAll } from "../src/store/integrity.js";

process.env.MONOMEM_HISTORY_VERSIONS = "500"; // the property is about what was acknowledged; keep every version
const WORKER = fileURLToPath(new URL("./lossless-worker.js", import.meta.url));
const MS = Number(process.env.MONOMEM_LOSSLESS_MS ?? 4000);
type Ack = { id: number; rev: number; body: string };

const run = (dir: string, seed: number, ms: number, killAfter: number | null): Promise<void> =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [WORKER, join(dir, "state.db"), String(seed), String(ms), join(dir, `ack-${seed}.jsonl`)], { stdio: "ignore", env: { ...process.env, MONOMEM_HOME: dir, ONEMEMORY_HOME: dir } });
    if (killAfter !== null) setTimeout(() => c.kill("SIGKILL"), killAfter);
    c.on("close", () => resolve());
  });

function readAcks(dir: string, seeds: number[]): Ack[] {
  const out: Ack[] = [];
  for (const seed of seeds) {
    const f = join(dir, `ack-${seed}.jsonl`);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      try {
        if (line.trim()) out.push(JSON.parse(line) as Ack); // the last line of a killed process may be cut: it was not acknowledged to anyone
      } catch {
        /* partial line */
      }
    }
  }
  return out;
}

test("random multi-process writes with one writer killed: every acknowledged write is in the ledger and readable; the store verifies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-lossless-"));
  try {
    const first = new Store(join(dir, "state.db"));
    first.create({ title: "seed", body: "seed" });
    first.close();
    const seeds = [1, 2, 3];
    await Promise.all([run(dir, 1, MS, 1000 + Math.floor(Math.random() * Math.max(500, MS / 2))), run(dir, 2, MS, null), run(dir, 3, MS, null)]);
    const acks = readAcks(dir, seeds);
    assert.ok(acks.length >= 10, `too few acknowledged writes to mean anything (${acks.length})`);
    const s = new Store(join(dir, "state.db"));
    // L1: acknowledged implies in the ledger
    assert.deepEqual(missingAcks(s, acks), [], "an acknowledged write has no ledger entry");
    // readable: live now, or kept as an earlier version
    const live = new Map((s.db.prepare("SELECT id, body FROM notes").all() as Array<{ id: number; body: string }>).map((r) => [Number(r.id), r.body]));
    const kept = new Map<number, Set<string>>();
    for (const h of s.db.prepare("SELECT note_id, body FROM note_history").all() as Array<{ note_id: number; body: string }>) {
      const set = kept.get(Number(h.note_id)) ?? new Set<string>();
      set.add(h.body);
      kept.set(Number(h.note_id), set);
    }
    const lost = acks.filter((a) => live.get(a.id) !== a.body && !kept.get(a.id)?.has(a.body));
    assert.deepEqual(lost, [], "an acknowledged text is neither live nor in history");
    // every rev is claimed by one writer only: the database enforces it (UNIQUE(note_id, rev) on the ledger), so ask the ledger.
    // The ack files cannot be used for this: store.update() re-reads the row after it commits, so a writer can be handed a LATER
    // writer's rev in its reply (two acks, one rev, two different bodies) while both writes are in the ledger under their own revs.
    const dup = s.db.prepare("SELECT note_id, rev, COUNT(*) AS n FROM ledger WHERE rb = 1 GROUP BY note_id, rev HAVING n > 1").all();
    assert.deepEqual(dup, [], "two ledger entries for one note revision");
    const rep = verifyAll(s, { signatures: true });
    assert.deepEqual(rep.issues.filter((i) => i.severity === "fail"), [], JSON.stringify(rep.issues));
    assert.deepEqual(rep.held, ["L2", "L3", "L4", "L6"]);
    s.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* removed with the test root */
    }
  }
});

test("L5: export then import into an empty store keeps every title, body and tag", async () => {
  const a = new Store(":memory:");
  for (let i = 0; i < 20; i++) a.create({ title: `t${i}`, body: `body ${i}\nline`, tags: [`g${i % 3}`] });
  const out = a.exportAll();
  const b = new Store(":memory:");
  await b.importNotes(out.map((n) => ({ ...n })) as never);
  const key = (s: Store): string[] => s.exportAll().map((n) => JSON.stringify([n.title, n.body, [...n.tags].sort()])).sort();
  assert.deepEqual(key(b), key(a));
  assert.deepEqual(verifyAll(b).issues.filter((i) => i.severity === "fail"), []);
  a.close();
  b.close();
});
