// PLAN I: branch-scoped memory (repo > branch > global) and the memory-to-commit trail (why --commits, the commit line).
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { injectContext, rankContext } from "../src/context-inject.js";
import { receiptAdd } from "../src/receipts.js";
import { gitHead, recordBranch, commitsUsing, trailerValue } from "../src/git-trail.js";
import { hookPlace, installHook, isOurs, removeHook } from "../src/cli/commit-trail.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const g = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=T", "-c", "core.hooksPath=", ...args], { cwd, encoding: "utf8" });
const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mm-trail-"));
  g(dir, "init", "-q", "-b", "main");
  g(dir, "config", "user.email", "t@example.test");
  g(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "a");
  g(dir, "add", ".");
  g(dir, "commit", "-q", "-m", "first");
  return dir;
}

describe("branch scope", () => {
  test("gitHead reads repo and branch from the .git files; a worktree shares the repo, not the branch", () => {
    const dir = repo();
    try {
      const main = gitHead(join(dir))!;
      assert.equal(main.branch, "main");
      g(dir, "worktree", "add", "-q", "-b", "feat", join(dir, "..", `${dir.split(/[\\/]/).pop()}-wt`));
      const wt = gitHead(join(dir, "..", `${dir.split(/[\\/]/).pop()}-wt`))!;
      assert.equal(wt.branch, "feat");
      assert.equal(wt.repo, main.repo);
      assert.equal(gitHead(tmpdir() + "/definitely-not-a-repo-" + Date.now()), null);
      rmSync(join(dir, "..", `${dir.split(/[\\/]/).pop()}-wt`), { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("current branch first; a live other branch is labelled and kept back; a merged branch counts as the repo's", async () => {
    const dir = repo();
    const s = new Store(":memory:");
    try {
      g(dir, "branch", "feat"); // unmerged once it has its own commit
      g(dir, "checkout", "-q", "feat");
      writeFileSync(join(dir, "f.txt"), "f");
      g(dir, "add", ".");
      g(dir, "commit", "-q", "-m", "feat work");
      g(dir, "checkout", "-q", "main");
      g(dir, "branch", "done"); // merged: points at main
      const mk = (title: string, minutes: number, branch: string | null): number => {
        const id = s.create({ title, body: title }).id;
        s.captureDb().prepare("UPDATE notes SET writer_cwd = ?, created_at = ?, updated_at = ? WHERE id = ?").run(dir, minutesAgo(minutes), minutesAgo(minutes), id);
        recordBranch(s.captureDb(), id, dir);
        if (branch !== "main") s.captureDb().prepare("UPDATE note_branches SET branch = ? WHERE note_id = ?").run(branch, id);
        return id;
      };
      const onMain = mk("written on main", 30, "main");
      const onFeat = mk("half-baked experiment on feat", 1, "feat");
      const onDone = mk("from the merged branch", 2, "done");
      const signals = { branch: "main", diffFiles: [], root: dir };
      const { ranked, otherBranch } = await rankContext(s, { signals });
      const order = ranked.map((n) => n.id);
      assert.ok(order.indexOf(onMain) < order.indexOf(onFeat), `main before feat: ${order}`);
      assert.ok(order.indexOf(onDone) < order.indexOf(onFeat), `merged branch is repo scope: ${order}`);
      assert.deepEqual([...otherBranch.entries()], [[onFeat, "feat"]]);
      const text = await injectContext(s, { signals });
      assert.match(text, new RegExp(`#${onFeat}\\b.*\\(branch feat\\)`));
      assert.doesNotMatch(text, /\(branch done\)|\(branch main\)/);
      // After feat is merged, its notes are the repo's: no label.
      g(dir, "merge", "-q", "--no-edit", "feat");
      const after = await rankContext(s, { signals });
      assert.equal(after.otherBranch.size, 0);
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a local agent write records the branch of its folder (stdio writer with a cwd)", async () => {
    const dir = repo();
    const db = join(dir, "..", `${dir.split(/[\\/]/).pop()}.db`);
    try {
      g(dir, "checkout", "-q", "-b", "topic");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const client = new Client({ name: "branch-test", version: "1" });
      const env = { PATH: process.env.PATH ?? "", HOME: join(dir, "..", "h"), USERPROFILE: join(dir, "..", "h"), MONOMEM_HOME: join(dir, "..", "om"), MONOMEM_DB_PATH: db, MONOMEM_CLIENT: "cursor" };
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, cwd: dir, stderr: "ignore" }));
      try {
        await client.callTool({ name: "state_write", arguments: { title: "branch probe", body: "x" } });
      } finally {
        await client.close();
      }
      const s = new Store(db);
      try {
        const row = s.captureDb().prepare("SELECT b.branch FROM note_branches b JOIN notes n ON n.id = b.note_id WHERE n.title = 'branch probe'").get() as { branch: string } | undefined;
        assert.equal(row?.branch, "topic");
      } finally {
        s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(db, { force: true });
    }
  });
});

describe("commit trail", () => {
  test("why --commits: only the commits of the session that was shown the note (two-session fixture)", async () => {
    const a = repo();
    const b = repo();
    const s = new Store(":memory:");
    try {
      const n42 = s.create({ title: "use port 8443", body: "x" }).id;
      const other = s.create({ title: "unrelated", body: "y" }).id;
      const db = s.captureDb();
      const ins = db.prepare("INSERT INTO sessions (id, namespace, cwd, started_at) VALUES (?, '', ?, ?)");
      await new Promise((r) => setTimeout(r, 1100)); // git times are whole seconds: the repos' first commits stay before the sessions
      const started = new Date().toISOString();
      ins.run("sess-A", a, started);
      ins.run("sess-B", b, started);
      receiptAdd(s, { sessionId: "sess-A", namespace: "", client: "t", shown: [{ id: n42, why: "{recent 0d}", tokens: 3 }] });
      receiptAdd(s, { sessionId: "sess-B", namespace: "", client: "t", shown: [{ id: other, why: "{recent 0d}", tokens: 3 }] });
      for (const [dir, msg] of [[a, "A did it"], [b, "B did it"]]) {
        writeFileSync(join(dir, "c.txt"), msg);
        g(dir, "add", ".");
        g(dir, "commit", "-q", "-m", msg);
      }
      // A commit whose own line names another note is not counted for #42.
      writeFileSync(join(a, "d.txt"), "d");
      g(a, "add", ".");
      g(a, "commit", "-q", "-m", "other work", "-m", `Monomem-Notes: #${other}`);
      const hits = await commitsUsing(db, n42);
      assert.deepEqual(hits.map((h) => h.commit.subject), ["A did it"]);
      assert.deepEqual(hits[0].how, ["shown"]);
      assert.equal(hits[0].session, "sess-A");
    } finally {
      s.close();
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("trailerValue: note ids of open sessions inside the repo only, archived left out, capped", () => {
    const s = new Store(":memory:");
    try {
      const ids = Array.from({ length: 15 }, (_, i) => s.create({ title: `n${i}`, body: "b" }).id);
      s.captureDb().prepare("INSERT INTO sessions (id, namespace, cwd, started_at) VALUES ('s1', '', '/work/app', ?)").run(minutesAgo(1));
      receiptAdd(s, { sessionId: "s1", namespace: "", client: "t", shown: ids.map((id) => ({ id, why: "{recent 0d}", tokens: 1 })) });
      s.archive(ids[0]);
      const v = trailerValue(s.captureDb(), [{ id: "s1", cwd: "/work/app/sub" }], "/work/app");
      assert.match(v, /^(#\d+ ){12}\+2$/);
      assert.ok(!v.includes(`#${ids[0]} `) && v.startsWith(`#${ids[1]} `), v);
      assert.equal(trailerValue(s.captureDb(), [{ id: "s1", cwd: "/elsewhere" }], "/work/app"), "");
    } finally {
      s.close();
    }
  });

  test("the git hook adds the line to a commit made while a session works here; amend does not repeat it; off removes it", async () => {
    const dir = repo();
    const home = mkdtempSync(join(tmpdir(), "mm-trail-home-"));
    const db = join(home, "state.db");
    try {
      const s = new Store(db, { auditLog: join(home, "audit.log") });
      const id = s.create({ title: "shown note", body: "x" }).id;
      s.captureDb().prepare("INSERT INTO sessions (id, namespace, cwd, started_at) VALUES ('live', '', ?, ?)").run(dir, minutesAgo(1));
      receiptAdd(s, { sessionId: "live", namespace: "", client: "t", shown: [{ id, why: "{recent 0d}", tokens: 1 }] });
      s.close();
      const place = await hookPlace(dir);
      assert.ok(place.ok);
      if (!place.ok) return;
      {
        installHook(place.file, { mode: "npm", execPath: process.execPath, cliPath: CLI, platform: process.platform });
        assert.ok(isOurs(place.file));
        const env = { ...process.env, MONOMEM_DB_PATH: db, MONOMEM_HOME: home };
        const commit = (...args: string[]): void => void execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=T", ...args], { cwd: dir, env });
        writeFileSync(join(dir, "h.txt"), "h");
        commit("add", ".");
        commit("commit", "-q", "-m", "with memory");
        const msg = g(dir, "log", "-1", "--format=%B");
        assert.match(msg, new RegExp(`^Monomem-Notes: #${id}$`, "m"), msg);
        commit("commit", "-q", "--amend", "--no-edit");
        assert.equal((g(dir, "log", "-1", "--format=%B").match(/Monomem-Notes:/g) ?? []).length, 1);
        assert.ok(removeHook(place.file));
        assert.ok(!existsSync(place.file));
        // A hook someone else wrote is never replaced or removed.
        writeFileSync(place.file, "#!/bin/sh\nexit 0\n");
        assert.throws(() => installHook(place.file, { mode: "npm", execPath: process.execPath, cliPath: CLI, platform: process.platform }), /not Monomem's/);
        assert.equal(removeHook(place.file), false);
        assert.equal(readFileSync(place.file, "utf8"), "#!/bin/sh\nexit 0\n");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a repository with core.hooksPath (a hook manager) is refused, not edited", async () => {
    const dir = repo();
    try {
      mkdirSync(join(dir, ".husky"));
      g(dir, "config", "core.hooksPath", ".husky");
      const place = await hookPlace(dir);
      assert.equal(place.ok, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
