// Multi-process fuzz: several OS processes CAS-update, blind-update, create and archive the same few notes; some are killed with
// SIGKILL at random moments. Afterwards (L1-L6): every acknowledged write is in the ledger and readable; a CAS ack moved the note by
// exactly one revision; no revision was acknowledged twice; verify-lossless is clean after recovery, and a fresh process can still write.
// MONOMEM_FUZZ_MP_ROUNDS (default 1), MONOMEM_FUZZ_MP_PROCS (default 5), MONOMEM_FUZZ_MP_MS (default 2500) lengthen it.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { missingAcks, verifyAll } from "../src/store/integrity.js";
import { rng } from "./fuzz-model-lib.js";

process.env.MONOMEM_HISTORY_VERSIONS = "5000";
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "fuzz-mp-worker.js");
const CLI = join(HERE, "..", "src", "cli.js");
const num = (n: string, d: number): number => (process.env[n] !== undefined && Number.isFinite(Number(process.env[n])) ? Number(process.env[n]) : d);
const ROUNDS = num("MONOMEM_FUZZ_MP_ROUNDS", 1);
const PROCS = num("MONOMEM_FUZZ_MP_PROCS", 5);
const MS = num("MONOMEM_FUZZ_MP_MS", 2500);
type Ack = { id: number; rev: number; body: string; base: number };

test(`multi-process CAS writers with random SIGKILLs: ${ROUNDS} round(s) x ${PROCS} processes`, async () => {
  for (let round = 1; round <= ROUNDS; round++) {
    const dir = mkdtempSync(join(tmpdir(), "monomem-fuzzmp-"));
    try {
      const db = join(dir, "state.db");
      process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log");
      const first = new Store(db);
      for (let i = 0; i < 4; i++) first.create({ title: `seed ${i}`, body: `seed body ${i}` });
      first.close();
      const r = rng(round * 7919);
      const env = { ...process.env, MONOMEM_HOME: dir, ONEMEMORY_HOME: dir, MONOMEM_AUDIT_LOG: join(dir, "audit.log") };
      const runs: Array<Promise<void>> = [];
      for (let p = 0; p < PROCS; p++) {
        const kill = r() < 0.5 ? 300 + Math.floor(r() * (MS - 400)) : null;
        runs.push(new Promise((res) => {
          const c = spawn(process.execPath, [WORKER, db, String(round * 100 + p), String(MS), join(dir, `ack-${p}.jsonl`), `w${p}`], { stdio: "ignore", env });
          if (kill !== null) setTimeout(() => c.kill("SIGKILL"), kill);
          c.on("close", () => res());
        }));
      }
      await Promise.all(runs);
      const acks: Ack[] = [];
      for (let p = 0; p < PROCS; p++) {
        const f = join(dir, `ack-${p}.jsonl`);
        if (!existsSync(f)) continue;
        for (const line of readFileSync(f, "utf8").split("\n")) {
          try { if (line.trim()) acks.push(JSON.parse(line) as Ack); } catch { /* the cut last line of a killed process */ }
        }
      }
      assert.ok(acks.length >= 3, `round ${round}: too few acknowledged writes (${acks.length})`);
      const s = new Store(db);
      assert.deepEqual(missingAcks(s, acks), [], `round ${round}: L1, an acknowledged write has no ledger entry`);
      const live = new Map((s.db.prepare("SELECT id, body FROM notes").all() as Array<{ id: number; body: string }>).map((x) => [Number(x.id), x.body]));
      const kept = new Map<number, Set<string>>();
      for (const h of s.db.prepare("SELECT note_id, body FROM note_history").all() as Array<{ note_id: number; body: string }>) {
        const set = kept.get(Number(h.note_id)) ?? new Set<string>();
        set.add(h.body);
        kept.set(Number(h.note_id), set);
      }
      assert.deepEqual(acks.filter((a) => live.get(a.id) !== a.body && !kept.get(a.id)?.has(a.body)), [], `round ${round}: an acknowledged text is neither live nor in history`);
      assert.deepEqual(acks.filter((a) => a.base >= 0 && a.rev !== a.base + 1 && a.base !== 0), [], `round ${round}: a CAS write moved the note by more than one revision`);
      const seen = new Set<string>();
      for (const a of acks) {
        const k = `${a.id}:${a.rev}`;
        assert.ok(!seen.has(k), `round ${round}: revision ${k} acknowledged twice`);
        seen.add(k);
      }
      const rep = verifyAll(s, { signatures: true });
      assert.deepEqual(rep.issues.filter((i) => i.severity === "fail"), [], `round ${round}: ${JSON.stringify(rep.issues)}`);
      const n = s.create({ title: "after recovery", body: "still writable" });
      assert.equal(n.rev, 1);
      s.close();
      const cli = spawnSync(process.execPath, [CLI, "verify-lossless"], { env, encoding: "utf8" });
      assert.equal(cli.status, 0, `round ${round}: verify-lossless: ${cli.stdout}${cli.stderr}`);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* removed with the test root */ }
    }
  }
});
