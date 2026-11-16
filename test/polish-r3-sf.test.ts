import "./setup-env.js";
// 1.5.0 round 3 polish, item 3: SF-4 (flag flood pause sticks), SF-5 (git-sync replay stop, pinned), SF-6 (one audit line per refusal).
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { ValidationError } from "../src/errors.js";
import { runGitSync, type GitSyncOptions } from "../src/sync-git.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
let dir = "";
let log = "";
const lineCount = (): number => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "om-sf-"));
  log = join(dir, "audit.log");
  process.env.MONOMEM_AUDIT_LOG = log;
});
afterEach(() => {
  delete process.env.MONOMEM_AUDIT_LOG;
  delete process.env.MONOMEM_FLOOD_WRITES_PER_HOUR;
  rmSync(dir, { recursive: true, force: true });
});

describe("SF-4 / SF-6: a flood pause set while flagging stays, and a refusal is one audit line", () => {
  test("flagging past the flood limit pauses the writer for good (the pause is not rolled back), in one audit line", () => {
    const s = new Store(join(dir, "state.db"));
    const ids = [1, 2, 3, 4].map((i) => as("stdio:claude", () => s.create({ title: `note ${i}`, body: `body ${i}` })).id);
    process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "2";
    as("stdio:codex", () => {
      s.flagNote(ids[0], "looks wrong");
      s.flagNote(ids[1], "looks wrong");
    });
    const before = lineCount();
    let err: unknown;
    try {
      as("stdio:codex", () => s.flagNote(ids[2], "looks wrong"));
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ValidationError, "the third flag is refused");
    assert.ok(s.pausedWriters().includes("token:stdio:codex") || s.pausedWriters().some((w) => /codex/.test(w)), `paused: ${s.pausedWriters()}`);
    const receipt = s.refusedWriteReceipt(err);
    assert.equal(receipt?.decision, "refused");
    assert.equal(lineCount() - before, 1, "the refusal that pauses a writer is one audit line, not a pause line plus a refusal line");
    // and the next refusal of the paused writer is one line too
    const mid = lineCount();
    let again: unknown;
    try {
      as("stdio:codex", () => s.flagNote(ids[3], "looks wrong"));
    } catch (e) {
      again = e;
    }
    assert.ok(again instanceof ValidationError);
    s.refusedWriteReceipt(again);
    assert.equal(lineCount() - mid, 1);
    s.close();
  });
});

const haveGit = spawnSync("git", ["--version"]).status === 0;
const GITENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const g = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GITENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

describe("SF-5: git sync replay stop (pinned behaviour)", { skip: !haveGit && "git is not installed" }, () => {
  test("a computer that deleted a note and one that kept it with no seen record: what happens is pinned", async () => {
    const remote = join(dir, "remote.git");
    mkdirSync(remote);
    g(remote, "init", "--bare", "-b", "main");
    const dev = (name: string) => {
      mkdirSync(join(dir, name), { recursive: true });
      g(join(dir, name), "clone", remote, "repo");
      const repo = join(dir, name, "repo");
      g(repo, "checkout", "-B", "main");
      return { repo, dataDir: join(dir, name, "data"), db: join(dir, name, "data", "state.db") };
    };
    const a = dev("a");
    const b = dev("b");
    const run = (d: ReturnType<typeof dev>) => {
      const out: string[] = [];
      const x = { interactive: false, out: (l: string) => void out.push(l), err: (l: string) => void out.push(l), ask: async () => "" };
      const o: GitSyncOptions = { repo: d.repo, encrypt: true, dryRun: false, noPush: false, yes: true, dataDir: d.dataDir, dbPath: d.db, env: GITENV };
      return runGitSync(x, o).then((code) => ({ code, text: out.join("\n") }));
    };
    mkdirSync(a.dataDir, { recursive: true });
    const sa = new Store(a.db);
    const n = sa.create({ title: "Shared", body: "v1" });
    sa.close();
    assert.equal((await run(a)).code, 0);
    mkdirSync(b.dataDir, { recursive: true });
    writeFileSync(join(b.dataDir, ".sync-key"), readFileSync(join(a.dataDir, ".sync-key")));
    assert.equal((await run(b)).code, 0, "b pulls the note");
    const sa2 = new Store(a.db);
    sa2.update(n.id, { body: "v2" });
    sa2.close();
    assert.equal((await run(a)).code, 0);
    const sa3 = new Store(a.db);
    sa3.delete(n.id);
    sa3.close();
    assert.equal((await run(a)).code, 0, "a syncs the deletion");
    // b lost its seen record (a fresh data folder copy / reset) but still holds the note it pulled earlier
    for (const f of readdirSync(b.dataDir)) if (f.startsWith("sync-git-seen-")) rmSync(join(b.dataDir, f));
    const rb = await run(b);
    const ra = await run(a);
    // Pinned (SF-5, after tombstones): a's delete no longer removes the file; it stays (version 2) with an archive marker.
    // b, even with no seen record, reads that marker and archives its old copy: the delete is never resurrected, so a sees no
    // older file and never stops. The safety property is unchanged: nothing is silently lost. b keeps the text (archived,
    // restorable with `monomem restore`), a's delete stays a delete, and neither computer stops or needs a manual step.
    assert.equal(rb.code, 0, rb.text);
    assert.equal(ra.code, 0, ra.text);
    assert.doesNotMatch(ra.text, /older than one this computer already synced/);
    const onB = (() => {
      const s = new Store(b.db);
      try {
        return s.exportAll().find((x) => x.title === "Shared") ?? null;
      } finally {
        s.close();
      }
    })();
    assert.ok(onB, "b still holds the text: a delete never deletes on another computer");
    assert.ok(onB!.archived_at, "b archived its copy (the delete reached it as an archive, not a resurrection)");
    const onA = (() => {
      const s = new Store(a.db);
      try {
        return s.exportAll().find((x) => x.title === "Shared") ?? null;
      } finally {
        s.close();
      }
    })();
    assert.equal(onA, null, "a's delete is not undone by b's old copy");
    assert.equal((await run(b)).code, 0, "and the next syncs stay quiet");
    assert.equal((await run(a)).code, 0);
  });
});
