// Two real OS processes writing the SAME note without if_rev (an in-process test cannot reproduce this: node:sqlite is synchronous).
// The F1 failure: both were acknowledged with the same rev and one body vanished from history. Now every acknowledged write has
// its own rev, nothing is lost, and a stale if_rev is refused.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, StaleWriteError } from "../src/store.js";

process.env.MONOMEM_HISTORY_VERSIONS = "100"; // the default keeps 20 versions; this test keeps all of them
const WORKER = fileURLToPath(new URL("./cas-worker.js", import.meta.url));
type Ack = { body: string; rev: number };

function runWorker(dir: string, id: number, tag: string, n: number, go: string): Promise<Ack[]> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MONOMEM_HOME: dir, ONEMEMORY_HOME: dir };
    const c = spawn(process.execPath, [WORKER, join(dir, "state.db"), String(id), tag, String(n), go], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as Ack[]) : reject(new Error(`worker ${tag} exited ${code}: ${err}`))));
  });
}

test("two processes updating one note blind: every ack has its own rev and no body is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monomem-cas2-"));
  const N = 15;
  try {
    const s = new Store(join(dir, "state.db"));
    const note = s.create({ title: "shared", body: "base" });
    s.close();
    const go = join(dir, "go");
    const a = runWorker(dir, note.id, "A", N, go);
    const b = runWorker(dir, note.id, "B", N, go);
    await new Promise((r) => setTimeout(r, 1500)); // both children have opened the store and wait on the go file
    writeFileSync(go, "go");
    const acks = [...(await a), ...(await b)];

    assert.equal(acks.length, 2 * N);
    assert.equal(new Set(acks.map((x) => x.rev)).size, 2 * N, "two writers were acknowledged with the same rev (lost update)");
    const check = new Store(join(dir, "state.db"));
    const live = check.read(note.id)!;
    assert.equal(live.rev, 1 + 2 * N);
    const kept = new Set<string>([live.body, ...check.historyOf(note.id).map((h) => h.body)]);
    for (const x of acks) assert.ok(kept.has(x.body), `acknowledged body ${x.body} is neither live nor in history`);
    // the guard still works after the race: the rev an earlier writer holds is stale
    assert.throws(() => check.update(note.id, { body: "late" }, { ifRev: 2 }), StaleWriteError);
    check.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold a handle for a moment; the test root is removed on exit */ }
  }
});
