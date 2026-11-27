// 31-H5/M1/M2 and 30-F4/F5: the fix log is append-only and written first, undo is safe to repeat, and no folder is locked unless it is Monomem's.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, utimesSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, parse } from "node:path";
import { lockdownRefusal } from "../src/doctor/folder-guard.js";
import { runFixes, undoLastFix, planFixes, realCtx, FIX_LOG, type FixCtx } from "../src/doctor/fix.js";
import { Store } from "../src/store.js";
import { DatabaseSync } from "node:sqlite";

const BS = String.fromCharCode(92);
const WIDE = (d: string): string => `${d} BUILTIN${BS}Users:(OI)(CI)(R)\n  me:(F)\n`;
const io = (out: string[]) => ({ yes: true, interactive: false, ask: async () => "n", out: (s: string) => void out.push(s) });
function data(): { dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "mm-fixlog-"));
  const dir = join(root, "data");
  mkdirSync(dir);
  writeFileSync(join(dir, "state.db"), "");
  return { dir, root };
}
const logLines = (dir: string): string[] => readFileSync(join(dir, "doctor-fix", FIX_LOG), "utf8").trim().split("\n");
const steps = (dir: string): Array<{ kind: string; a: string; b: string }> => logLines(dir).map((l) => JSON.parse(l)).filter((l) => l.rec === "step").map((l) => l.step);
/** The fake icacls does not write the saved-permissions file the real one does: make it, so undo has something to restore. */
const saveFiles = (dir: string): void => steps(dir).forEach((s) => s.kind === "acl-restore" && writeFileSync(s.a, "saved"));
const winCtx = (dir: string, calls: string[][], failOn?: (a: string[]) => boolean): FixCtx =>
  realCtx({ dataDir: dir, platform: "win32", user: "me", env: { USERNAME: "me", USERDOMAIN: "PC" }, icacls: (a) => { calls.push(a); if (failOn?.(a)) throw new Error("icacls says no"); return a.length === 1 ? WIDE(a[0]) : ""; } });

describe("30-F4: what may be locked", () => {
  const ok = { env: { USERNAME: "me" } as NodeJS.ProcessEnv, user: "me" };
  test("a drive root, the home folder, a system folder, a folder with no Monomem file, and a USERNAME that is not the real account are refused", () => {
    const { dir, root } = data();
    assert.equal(lockdownRefusal(dir, ok), null);
    assert.match(lockdownRefusal(parse(dir).root, ok) ?? "", /drive root/);
    assert.match(lockdownRefusal(homedir(), ok) ?? "", /profile/);
    assert.match(lockdownRefusal(join(root, "Windows", "x"), { ...ok, env: { ...ok.env, SystemRoot: join(root, "Windows") } }) ?? "", /system folder/);
    assert.match(lockdownRefusal(root, ok) ?? "", /does not look like a Monomem data folder/);
    assert.match(lockdownRefusal(dir, { ...ok, user: "someone-else" }) ?? "", /could lock you out/);
    rmSync(root, { recursive: true, force: true });
  });
  test("doctor --fix does not offer the lockdown on a folder with no marker, and says why", async () => {
    const { dir, root } = data();
    rmSync(join(dir, "state.db"));
    const calls: string[][] = [];
    const out: string[] = [];
    assert.equal(await runFixes(winCtx(dir, calls), io(out)), 0);
    assert.match(out.join("\n"), /Not touching folder permissions: .*does not look like a Monomem/);
    assert.ok(!calls.some((c) => c.includes("/inheritance:r")));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("31-H5: the undo log", () => {
  test("a second fix run adds to the log; undo then puts back both runs", async () => {
    const { dir, root } = data();
    const calls: string[][] = [];
    const ctx: FixCtx = { ...winCtx(dir, calls), auditLog: join(dir, "audit.log") };
    assert.equal(await runFixes(ctx, io([])), 1); // run 1: lock
    const lock = `${ctx.auditLog}.append.lock`;
    mkdirSync(lock);
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    assert.equal(await runFixes({ ...ctx, now: ctx.now + 1000 }, io([])), 2, "run 2: lock again (the fake stays wide) and clear the stale lock");
    assert.deepEqual(steps(dir).map((s) => s.kind), ["acl-restore", "acl-restore", "move-back"]);
    saveFiles(dir);
    calls.length = 0;
    assert.equal(undoLastFix(ctx, () => undefined), 3);
    assert.equal(calls.filter((c) => c[1] === "/restore").length, 2, "both permission restores ran");
    assert.equal(existsSync(lock), true);
    rmSync(root, { recursive: true, force: true });
  });

  test("the undo step is on disk BEFORE the change: a failure half way still leaves the way back", async () => {
    const { dir, root } = data();
    const ctx = winCtx(dir, [], (a) => a.includes("/inheritance:r")); // the permissions were saved, then the lockdown call fails
    const out: string[] = [];
    assert.equal(await runFixes(ctx, io(out)), 0);
    assert.match(out.join("\n"), /Failed: icacls says no\. Part of this fix may have been done/);
    assert.equal(steps(dir).length, 1, "the step was recorded");
    rmSync(root, { recursive: true, force: true });
  });

  test("31-M1: undo twice does nothing the second time, so it cannot re-open a folder locked again by hand", async () => {
    const { dir, root } = data();
    const calls: string[][] = [];
    const ctx = winCtx(dir, calls);
    await runFixes(ctx, io([]));
    saveFiles(dir);
    assert.equal(undoLastFix(ctx, () => undefined), 1);
    const restores = calls.filter((c) => c[1] === "/restore").length;
    const out: string[] = [];
    assert.equal(undoLastFix(ctx, (s) => out.push(s)), 0);
    assert.equal(calls.filter((c) => c[1] === "/restore").length, restores, "no second restore");
    assert.match(out.join("\n"), /already been put back/);
    rmSync(root, { recursive: true, force: true });
  });

  test("an icacls failure or a damaged log line is a message, and the step stays on the list", async () => {
    const { dir, root } = data();
    const ctx = winCtx(dir, []);
    await runFixes(ctx, io([]));
    saveFiles(dir);
    appendFileSync(join(dir, "doctor-fix", FIX_LOG), "{not json\n");
    const out: string[] = [];
    assert.equal(undoLastFix(winCtx(dir, [], (a) => a[1] === "/restore"), (s) => out.push(s)), 0);
    assert.match(out.join("\n"), /1 line\(s\) of the fix log could not be read/);
    assert.match(out.join("\n"), /Could not undo a step of data-folder-acl: icacls says no/);
    assert.equal(undoLastFix(ctx, () => undefined), 1, "still on the list, done on the next try");
    rmSync(root, { recursive: true, force: true });
  });

  test("30-F5: a log entry that names a path this tool never uses is ignored", () => {
    const { dir, root } = data();
    const fixDir = join(dir, "doctor-fix");
    mkdirSync(fixDir);
    const victim = join(root, "elsewhere.txt");
    const planted = join(root, "planted.txt");
    writeFileSync(planted, "x");
    const entry = (seq: number, step: object): string => JSON.stringify({ rec: "step", seq, at: "t", fix: "evil", step }) + "\n";
    writeFileSync(join(fixDir, FIX_LOG), entry(1, { kind: "move-back", a: planted, b: victim }) + entry(2, { kind: "acl-restore", a: join(fixDir, "a.txt"), b: tmpdir() }));
    const calls: string[][] = [];
    const out: string[] = [];
    assert.equal(undoLastFix(winCtx(dir, calls), (s) => out.push(s)), 0);
    assert.equal(existsSync(victim), false);
    assert.equal(existsSync(planted), true);
    assert.equal(calls.length, 0);
    assert.equal(out.filter((l) => /paths are not where this tool puts things/.test(l)).length, 2);
    rmSync(root, { recursive: true, force: true });
  });

  test("31-M2: a store whose key file lives elsewhere (MONOMEM_KEY_FILE) is not offered the index rebuild", () => {
    const { dir, root } = data();
    const db = join(dir, "state.db");
    rmSync(db);
    const s = new Store(db);
    s.create({ title: "a", body: "b" });
    s.close();
    const raw = new DatabaseSync(db);
    raw.exec("INSERT INTO notes_fts(notes_fts) VALUES('delete-all')");
    raw.close();
    const ctx = realCtx({ dataDir: dir, dbPath: db, platform: "linux", icacls: () => "" });
    assert.deepEqual(planFixes(ctx).map((f) => f.id), ["search-index"], "plain store: offered");
    writeFileSync(join(root, "elsewhere.key"), "k");
    process.env.MONOMEM_KEY_FILE = join(root, "elsewhere.key");
    try {
      assert.deepEqual(planFixes(ctx).map((f) => f.id), [], "key found through MONOMEM_KEY_FILE: not offered");
    } finally {
      delete process.env.MONOMEM_KEY_FILE;
    }
    rmSync(root, { recursive: true, force: true });
  });
});
