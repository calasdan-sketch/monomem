// `monomem check --crash`: kill -9 self-test on a COPY of your store. Several writers save notes, each is killed with SIGKILL
// at a random moment, and after every round the copy is reopened: every write a writer was told succeeded must be there, and
// SQLite's own integrity check must say ok. Your real store is only read (VACUUM INTO a temp folder), never written.
// The claim it supports is narrow: "no acknowledged write lost in N kills on this machine". It is not a proof of anything else.
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CrashOptions {
  writers: number;
  rounds: number;
  /** The store to copy; undefined or missing file: start from an empty one. */
  source?: string;
  /** Test hook: the writer script. */
  writerScript?: string;
  /** Test hook: how long a round waits for its first acknowledged write (default 20 s). */
  ackWaitMs?: number;
}
export interface CrashResult {
  writers: number;
  rounds: number;
  kills: number;
  acknowledged: number;
  present: number;
  lost: number[];
  integrity: string;
  copiedFrom: "your store" | "an empty store";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MAX_WRITERS = 16;
const MAX_ROUNDS = 100;

/** Copy the live store into `dir/state.db` (a consistent snapshot, with the encryption key when there is one). */
function copyStore(source: string | undefined, dir: string): CrashResult["copiedFrom"] {
  if (!source || !existsSync(source)) return "an empty store";
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${join(dir, "state.db").split("'").join("''")}'`);
  } finally {
    db.close();
  }
  for (const f of [".key", ".attest-key"]) {
    const k = join(dirname(source), f);
    if (existsSync(k)) copyFileSync(k, join(dir, f));
  }
  return "your store";
}

/** Reopen (retrying: the first open after a kill can need a moment) and return the acknowledged ids still present + integrity. */
async function inspect(db: string, ids: ReadonlySet<number>): Promise<{ present: number; lost: number[]; integrity: string }> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const h = new DatabaseSync(db);
      try {
        h.exec("PRAGMA busy_timeout = 8000");
        const integrity = String((h.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check);
        const tableThere = h.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'notes'").get() !== undefined;
        const have = new Set((tableThere ? (h.prepare("SELECT id FROM notes").all() as Array<{ id: number }>) : []).map((r) => Number(r.id)));
        const lost = [...ids].filter((i) => !have.has(i));
        return { present: ids.size - lost.length, lost, integrity };
      } finally {
        h.close();
      }
    } catch (e) {
      last = e;
      await sleep(350); // "another Monomem process just stopped": give SQLite a moment, then try again
    }
  }
  throw new Error(`could not reopen the test copy after 4 tries: ${(last as Error).message}`);
}

/**
 * The environment of a writer: the parent's with every MONOMEM_*, ONEMEMORY_* and CLAUDE_BRIDGE_* variable dropped, and the
 * home, database and audit log pinned inside the temp folder. A writer that inherited these wrote thousands of fake "create"
 * lines into the REAL tamper-evident audit log (review 31-H1).
 */
export function writerEnv(dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!/^(MONOMEM_|ONEMEMORY_|CLAUDE_BRIDGE_)/.test(k)) env[k] = v;
  return { ...env, MONOMEM_HOME: dir, ONEMEMORY_HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db"), MONOMEM_AUDIT_LOG: join(dir, "audit.log") };
}

/** Kill every writer and delete the temp copy (it holds your notes and key). Safe to call twice; never throws. */
export function cleanupCrashRun(dir: string, kids: Iterable<ChildProcess>): void {
  for (const c of kids) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  } catch (e) {
    process.stderr.write(`monomem: could not delete the temporary copy ${dir} (${(e as Error).message}). It holds a copy of your notes: delete it by hand.\n`);
  }
}

/** Run `cleanup` on Ctrl+C, termination and exit so the copy is never left behind. Returns the function that removes the hooks. */
export function guardCleanup(cleanup: () => void, exit: (code: number) => void = (c) => process.exit(c)): () => void {
  const onSignal = (): void => {
    cleanup();
    exit(130);
  };
  const sigs = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const s of sigs) process.on(s, onSignal);
  process.on("exit", cleanup);
  return () => {
    for (const s of sigs) process.off(s, onSignal);
    process.off("exit", cleanup);
  };
}

const lastLine = (s: string): string => s.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? "";

async function round(script: string, db: string, n: number, tag: string, ids: Set<number>, env: NodeJS.ProcessEnv, live: Set<ChildProcess>, ackWaitMs: number): Promise<void> {
  let errText = "";
  let exited = 0;
  const kids = Array.from({ length: n }, (_, k) => {
    const c = spawn(process.execPath, [script, db, `${tag}w${k}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
    live.add(c);
    // ACK lines are read whole: a number cut by a chunk edge or by the kill must not count as a shorter id.
    let pending = "";
    c.stdout.on("data", (d: Buffer) => {
      const lines = (pending + d.toString()).split("\n");
      pending = lines.pop() ?? "";
      for (const l of lines) {
        const m = /^ACK (\d+)\r?$/.exec(l);
        if (m) ids.add(Number(m[1]));
      }
    });
    c.stderr.on("data", (d: Buffer) => (errText = (errText + d.toString()).slice(-2000)));
    c.on("error", (e) => (errText += e.message));
    return { c, done: new Promise<void>((r) => c.once("close", () => (exited++, live.delete(c), r()))) };
  });
  // Wait until a writer is going, then let them run a random moment before the kill.
  const before = ids.size;
  const t0 = Date.now();
  while (ids.size === before && exited < n && Date.now() - t0 < ackWaitMs) await sleep(50);
  const acked = ids.size > before;
  if (acked) await sleep(40 + Math.floor(Math.random() * 260));
  for (const k of kids) k.c.kill("SIGKILL");
  await Promise.all(kids.map((k) => k.done));
  if (!acked) throw new Error(`no writer saved a note in this round, so nothing was tested${lastLine(errText) ? ` (writer said: ${lastLine(errText)})` : ""}.`);
}

export async function runCrashCheck(o: CrashOptions): Promise<CrashResult> {
  if (!Number.isInteger(o.writers) || o.writers < 1 || o.writers > MAX_WRITERS) throw new Error(`--writers must be 1 to ${MAX_WRITERS}`);
  if (!Number.isInteger(o.rounds) || o.rounds < 1 || o.rounds > MAX_ROUNDS) throw new Error(`--rounds must be 1 to ${MAX_ROUNDS}`);
  const dir = mkdtempSync(join(tmpdir(), "monomem-crash-"));
  const live = new Set<ChildProcess>();
  const unguard = guardCleanup(() => cleanupCrashRun(dir, live));
  try {
    const copiedFrom = copyStore(o.source, dir);
    const script = o.writerScript ?? join(dirname(fileURLToPath(import.meta.url)), "crash-writer.js");
    const db = join(dir, "state.db");
    const ids = new Set<number>();
    const result = (rounds: number, i: { present: number; lost: number[]; integrity: string }): CrashResult => ({ writers: o.writers, rounds, kills: rounds * o.writers, acknowledged: ids.size, present: i.present, lost: i.lost, integrity: i.integrity, copiedFrom });
    for (let r = 0; r < o.rounds; r++) {
      await round(script, db, o.writers, `r${r}`, ids, writerEnv(dir), live, o.ackWaitMs ?? 20_000);
      // Checked every round: a loss in round 3 is reported as such.
      const seen = await inspect(db, ids);
      if (seen.lost.length || seen.integrity !== "ok" || r === o.rounds - 1) return result(r + 1, seen);
    }
    return result(0, { present: 0, lost: [], integrity: "ok" });
  } finally {
    unguard();
    cleanupCrashRun(dir, live);
  }
}

export function crashLine(r: CrashResult): string {
  const verdict = r.lost.length || r.integrity !== "ok" || r.acknowledged === 0 ? "FAIL" : "ok";
  return `${r.writers} writers killed with kill -9 over ${r.rounds} rounds (${r.kills} kills), on a copy of ${r.copiedFrom}: ${r.acknowledged} acknowledged writes, ${r.present} present. Integrity check: ${r.integrity}. Result: ${verdict}.`;
}

/** `monomem crash-check [--writers n] [--rounds n]` (also: monomem check --crash). */
export async function crashCheckMain(args: string[]): Promise<number> {
  const nums: Record<string, number> = { writers: 4, rounds: 12 };
  for (let i = 0; i < args.length; i++) {
    const m = /^--(writers|rounds)(?:=(.*))?$/.exec(args[i]);
    if (!m) {
      console.error(`Unknown option: ${args[i]}`);
      return 2;
    }
    nums[m[1]] = Number(m[2] ?? args[++i]);
  }
  const { DB_PATH } = await import("../config.js");
  console.log("monomem check --crash\n");
  console.log("Copying your store to a temporary folder and killing writers on the copy. Your real store is only read.");
  try {
    const r = await runCrashCheck({ writers: nums.writers, rounds: nums.rounds, source: DB_PATH });
    console.log(crashLine(r));
    if (r.lost.length) console.log(`Lost note ids: ${r.lost.slice(0, 20).join(", ")}`);
    console.log("This shows no acknowledged write was lost on this machine in these kills. It does not cover a power cut or a failing disk.");
    if (r.acknowledged === 0) console.error("Nothing was tested: no write was acknowledged, so this run proves nothing.");
    return r.lost.length || r.integrity !== "ok" || r.acknowledged === 0 ? 1 : 0;
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`);
    return 1;
  }
}
