// `monomem check --setup --fix` (also `monomem doctor --fix`): the SAFE automatic fixes, each explained first and each undoable.
//   1. Windows: the data folder is open to other accounts (Users, Everyone ...). Locked to you and SYSTEM with icacls; the old
//      permissions are saved first and `--undo-fix` puts them back.
//   2. A stale lock: a lock folder of the audit log left by a program that was killed, or a server.pid whose program is gone.
//      MOVED (not deleted) into <data>/doctor-fix/; `--undo-fix` moves it back.
//   Every step is written to an append-only log (doctor-fix/doctor-fix-log.jsonl) BEFORE it is done; --undo-fix can run twice safely.
//   The lockdown is refused unless the folder holds a Monomem marker file (see folder-guard.ts).
//   3. A search index that does not match the notes (unencrypted stores only): rebuilt from the notes. Derived data: no note is
//      read for anything else or changed, so there is nothing to undo.
// Never touches note data, tokens or keys. Without --yes at a terminal each fix asks first; piped, without --yes, it only lists.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { encryptionEnabled } from "../crypto.js";
import { sealedRowsExist } from "../store/write-lock.js";
import { lockdownRefusal } from "./folder-guard.js";
import { appendLine, nextSeq, pendingSteps, stepPathsOk, FIX_LOG, type UndoStep } from "./fix-log.js";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { lockdownArgs, wideAccessGroups } from "../private-dir.js";

export interface FixCtx {
  dataDir: string;
  dbPath: string;
  auditLog: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  now: number;
  /** icacls runner; returns stdout. Test hook. */
  icacls: (args: string[], cwd?: string) => string;
  /** Is this process id running? Test hook. */
  alive: (pid: number) => boolean;
  /** Where moved files and saved permissions go. */
  fixDir: string;
  /** The account this process really runs as (test hook). */
  user?: string;
}
export type { UndoStep };
export interface Fix {
  id: string;
  title: string;
  /** What is wrong, in plain words. */
  why: string;
  /** Exactly what the fix does. */
  change: string;
  /** How to take it back. */
  undo: string;
  /** Does the change. `record` MUST be called with each undo step BEFORE the change it undoes. */
  apply(record: (s: UndoStep) => void): void;
}

const STALE_LOCK_MS = 10_000;
export { FIX_LOG };
const folderRefusal = (ctx: FixCtx): string | null => lockdownRefusal(ctx.dataDir, { env: ctx.env, user: ctx.user });

export function realCtx(over: Partial<FixCtx> = {}): FixCtx {
  const dataDir = over.dataDir ?? "";
  return {
    dataDir,
    dbPath: join(dataDir, "state.db"),
    auditLog: process.env.MONOMEM_AUDIT_LOG ?? join(dataDir, "audit.log"),
    platform: process.platform,
    env: process.env,
    now: Date.now(),
    icacls: (args, cwd) => execFileSync("icacls", args, { encoding: "utf8", timeout: 30_000, windowsHide: true, ...(cwd ? { cwd } : {}) }),
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    fixDir: join(dataDir, "doctor-fix"),
    ...over,
  };
}

const stamp = (ctx: FixCtx): string => new Date(ctx.now).toISOString().replace(/[:.]/g, "-");

function aclFix(ctx: FixCtx): Fix | null {
  if (ctx.platform !== "win32" || !existsSync(ctx.dataDir) || folderRefusal(ctx)) return null;
  let wide: string[];
  try {
    wide = wideAccessGroups(ctx.icacls([ctx.dataDir]));
  } catch {
    return null; // icacls missing or the folder has no ACLs: nothing safe to do
  }
  const args = lockdownArgs(ctx.dataDir, ctx.env);
  if (!wide.length || !args) return null;
  return {
    id: "data-folder-acl",
    title: "Lock the data folder to your account",
    why: `Other accounts on this PC can reach the data folder (${wide.join(", ")}).`,
    change: `Run icacls on ${ctx.dataDir}: leave it to you and SYSTEM only. The current permissions are saved first.`,
    undo: "monomem check --setup --undo-fix",
    apply: (record) => {
      const refusal = folderRefusal(ctx);
      if (refusal) throw new Error(refusal);
      mkdirSync(ctx.fixDir, { recursive: true });
      const saved = join(ctx.fixDir, `acl-${stamp(ctx)}.txt`);
      record({ kind: "acl-restore", a: saved, b: dirname(ctx.dataDir) }); // before the first icacls call, so a failure half way can still be undone
      ctx.icacls([ctx.dataDir, "/save", saved, "/t", "/c"]);
      ctx.icacls(args);
    },
  };
}

function moveAway(ctx: FixCtx, from: string, record: (s: UndoStep) => void): void {
  mkdirSync(ctx.fixDir, { recursive: true });
  const to = join(ctx.fixDir, `${stamp(ctx)}-${basename(from)}`);
  record({ kind: "move-back", a: to, b: from });
  renameSync(from, to);
}

function lockFixes(ctx: FixCtx): Fix[] {
  const out: Fix[] = [];
  const lock = `${ctx.auditLog}.append.lock`;
  try {
    if (existsSync(lock) && ctx.now - statSync(lock).mtimeMs > STALE_LOCK_MS) {
      out.push({
        id: "stale-audit-lock",
        title: "Clear a stale audit-log lock",
        why: `${lock} was left by a program that was killed (older than ${STALE_LOCK_MS / 1000} seconds); it is ignored but never cleaned up.`,
        change: "Move it into the doctor-fix folder (nothing is deleted).",
        undo: "monomem check --setup --undo-fix",
        apply: (record) => moveAway(ctx, lock, record),
      });
    }
  } catch {
    /* gone while looking: nothing to fix */
  }
  const pid = join(dirname(ctx.dbPath), "server.pid");
  try {
    const rec = existsSync(pid) ? (JSON.parse(readFileSync(pid, "utf8")) as { pid?: unknown }) : null;
    if (rec && Number.isInteger(rec.pid) && !ctx.alive(Number(rec.pid))) {
      out.push({
        id: "stale-server-pid",
        title: "Clear a stale server record",
        why: `server.pid names a background server (process ${String(rec.pid)}) that is no longer running.`,
        change: "Move server.pid into the doctor-fix folder.",
        undo: "monomem check --setup --undo-fix",
        apply: (record) => moveAway(ctx, pid, record),
      });
    }
  } catch {
    /* unreadable record: leave it for the person to look at */
  }
  return out;
}

function indexFix(ctx: FixCtx): Fix | null {
  // encrypted (a key file wherever MONOMEM_KEY_FILE puts it): the rebuild belongs to `monomem tidy reindex`
  if (!existsSync(ctx.dbPath) || encryptionEnabled(dirname(ctx.dbPath))) return null;
  let mismatch = false;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(ctx.dbPath, { readOnly: true });
    const n = Number((db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
    const f = Number((db.prepare("SELECT COUNT(*) AS c FROM notes_fts_docsize").get() as { c: number }).c);
    mismatch = n !== f && !sealedRowsExist(db); // sealed notes have no body to index: a count gap is normal there
  } catch {
    return null;
  } finally {
    db?.close();
  }
  if (!mismatch) return null;
  return {
    id: "search-index",
    title: "Rebuild the search index",
    why: "The word-search index does not hold the same notes as the database, so some notes cannot be found by words.",
    change: "Rebuild the index from the notes (INSERT INTO notes_fts(notes_fts) VALUES('rebuild')). Notes are not changed.",
    undo: "Nothing to undo: the index is derived from the notes.",
    apply: () => {
      const w = new DatabaseSync(ctx.dbPath);
      try {
        w.exec("PRAGMA busy_timeout = 8000");
        w.exec("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')");
      } finally {
        w.close();
      }
    },
  };
}

/** The fixes that apply now. Reads only. */
export function planFixes(ctx: FixCtx): Fix[] {
  return [aclFix(ctx), ...lockFixes(ctx), indexFix(ctx)].filter((f): f is Fix => f !== null);
}

/** Folders an undo may move a file back into: the ones this tool took it from. */
const undoRoots = (ctx: FixCtx): string[] => [ctx.dataDir, dirname(ctx.dbPath), dirname(ctx.auditLog)];

/** Undo one recorded step. Returns a plain sentence and whether the step is finished (so it is not tried again). */
function undoOne(ctx: FixCtx, fix: string, step: UndoStep): { msg: string; finished: boolean; did: boolean } {
  if (!stepPathsOk(step, ctx.fixDir, ctx.dataDir, undoRoots(ctx))) return { msg: `Left alone a log entry (${fix}): its paths are not where this tool puts things.`, finished: false, did: false };
  if (step.kind === "acl-restore") {
    const refusal = folderRefusal(ctx);
    if (refusal) return { msg: `Did not restore permissions (${fix}): ${refusal}.`, finished: false, did: false };
    if (!existsSync(step.a)) return { msg: `The saved permissions file is gone, so nothing was changed before it (${fix}).`, finished: true, did: false };
    ctx.icacls([step.b, "/restore", step.a, "/c"]);
    return { msg: `Put back the saved permissions of ${ctx.dataDir} (${fix}).`, finished: true, did: true };
  }
  if (!existsSync(step.a)) return { msg: `${basename(step.b)} was never moved (${fix}); nothing to put back.`, finished: true, did: false };
  if (existsSync(step.b)) return { msg: `Did not move ${basename(step.b)} back (${fix}): a file is there already.`, finished: false, did: false };
  renameSync(step.a, step.b);
  return { msg: `Moved ${basename(step.b)} back (${fix}).`, finished: true, did: true };
}

/** Put back what the fix runs changed, newest step first. Safe to run twice: a step already undone is skipped. Returns the number undone. */
export function undoLastFix(ctx: FixCtx, out: (s: string) => void): number {
  if (!existsSync(join(ctx.fixDir, FIX_LOG))) {
    out("No fix has been applied here, so there is nothing to undo.");
    return 0;
  }
  const { steps, bad } = pendingSteps(ctx.fixDir);
  if (bad) out(`${bad} line(s) of the fix log could not be read and were skipped.`);
  if (!steps.length) out("Everything a fix changed has already been put back; nothing to undo.");
  let n = 0;
  for (const p of steps) {
    try {
      const r = undoOne(ctx, p.fix, p.step);
      out(r.msg);
      if (r.finished) appendLine(ctx.fixDir, { rec: "undone", seq: p.seq, at: new Date(ctx.now).toISOString() });
      if (r.did) n++;
    } catch (e) {
      out(`Could not undo a step of ${p.fix}: ${(e as Error).message}. It stays on the list: run --undo-fix again.`);
    }
  }
  return n;
}

export interface FixIO {
  yes: boolean;
  interactive: boolean;
  ask: (q: string) => Promise<string>;
  out: (s: string) => void;
}

/** Explain each fix, ask (unless --yes), apply, and log each undo step first. Returns the number applied. */
export async function runFixes(ctx: FixCtx, io: FixIO): Promise<number> {
  const plan = planFixes(ctx);
  const refusal = ctx.platform === "win32" && existsSync(ctx.dataDir) ? folderRefusal(ctx) : null;
  if (refusal) io.out(`Not touching folder permissions: ${refusal}.`);
  if (!plan.length) {
    io.out("Nothing to fix automatically. (Anything else doctor reports needs a decision from you.)");
    return 0;
  }
  let seq = nextSeq(ctx.fixDir);
  let applied = 0;
  for (const f of plan) {
    io.out(`\n${f.title}\n  Problem: ${f.why}\n  Change:  ${f.change}\n  Undo:    ${f.undo}`);
    if (!io.yes) {
      if (!io.interactive) {
        io.out("  (Not applied: run with --yes to apply, or at a terminal to be asked.)");
        continue;
      }
      if (!/^y(es)?$/i.test((await io.ask("  Apply this fix? [y/N] ")).trim())) {
        io.out("  Skipped.");
        continue;
      }
    }
    try {
      f.apply((step) => appendLine(ctx.fixDir, { rec: "step", seq: seq++, at: new Date(ctx.now).toISOString(), fix: f.id, step }));
      applied++;
      io.out("  Done.");
    } catch (e) {
      io.out(`  Failed: ${(e as Error).message}. Part of this fix may have been done: whatever it changed is in the undo log, so ${f.undo} puts it back.`);
    }
  }
  return applied;
}

/** The command: argv after `doctor`/`check --setup`. */
export async function fixMain(args: string[]): Promise<number> {
  const { DATA_DIR, DB_PATH } = await import("../config.js");
  const ctx = realCtx({ dataDir: DATA_DIR, dbPath: DB_PATH });
  const known = new Set(["--fix", "--undo-fix", "--yes", "--verbose"]);
  const bad = args.find((a) => a.startsWith("--") && !known.has(a));
  if (bad) {
    console.error(`Unknown option: ${bad}`);
    return 2;
  }
  console.log("monomem check --setup --fix\n");
  if (args.includes("--undo-fix")) {
    undoLastFix(ctx, (s) => console.log(s));
    return 0;
  }
  const { terminalIO } = await import("../cli/shared.js");
  const t = terminalIO();
  const n = await runFixes(ctx, { yes: args.includes("--yes"), interactive: t.interactive, ask: t.ask, out: (s) => console.log(s) });
  console.log(`\n${n} fix(es) applied. Run monomem check --setup to see what is left.`);
  return 0;
}
