// A8: `sync --git` tombstones. A forget (archive) or a hard delete on one computer used to prune the note's file; the other
// computer wrote it back, and the two went on making remove / re-add commits forever, while the forget never reached the
// other computer. Now the file stays, with an `archived_at` / `archived_by` marker that does not change the content hash.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitSync, type GitSyncOptions } from "../src/sync-git.js";
import { Store } from "../src/store.js";

const haveGit = spawnSync("git", ["--version"]).status === 0;
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const GITENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } as NodeJS.ProcessEnv;
const g = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GITENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

interface Dev {
  repo: string;
  dataDir: string;
  db: string;
}

function world() {
  const root = mkdtempSync(join(tmpdir(), "om-tomb-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  g(remote, "init", "--bare", "-b", "main");
  const device = (name: string): Dev => {
    mkdirSync(join(root, name), { recursive: true });
    g(join(root, name), "clone", remote, "repo");
    const repo = join(root, name, "repo");
    g(repo, "checkout", "-B", "main");
    return { repo, dataDir: join(root, name, "data"), db: join(root, name, "data", "state.db") };
  };
  return { remote, a: device("a"), b: device("b") };
}

async function sync(d: Dev, o: Partial<GitSyncOptions> = {}): Promise<string> {
  const lines: string[] = [];
  const code = await runGitSync(
    { interactive: false, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => "" },
    { repo: d.repo, encrypt: false, dryRun: false, noPush: false, yes: true, dataDir: d.dataDir, dbPath: d.db, env: GITENV, ...o }
  );
  assert.equal(code, 0, lines.join("\n"));
  return lines.join("\n");
}
const withStore = <T>(d: Dev, fn: (s: Store) => T): T => {
  mkdirSync(d.dataDir, { recursive: true });
  const s = new Store(d.db);
  try {
    return fn(s);
  } finally {
    s.close();
  }
};
const commits = (remote: string): number => Number(g(remote, "rev-list", "--count", "main"));
const byTitle = (d: Dev, title: string) => withStore(d, (s) => s.exportAll().find((n) => n.title === title) ?? null);

const skip = !haveGit ? "git is not installed" : false;

for (const encrypt of [false, true]) {
  describe(`sync --git tombstones (${encrypt ? "sealed" : "plain"})`, { skip }, () => {
    const opts = { encrypt, ...(encrypt ? {} : {}) };
    const keyed = async (w: ReturnType<typeof world>) => {
      if (!encrypt) return;
      // One key on both computers, as the docs tell people to do.
      const { writeFileSync } = await import("node:fs");
      const { randomBytes } = await import("node:crypto");
      const k = randomBytes(32);
      for (const d of [w.a, w.b]) {
        mkdirSync(d.dataDir, { recursive: true });
        writeFileSync(join(d.dataDir, ".sync-key"), k);
      }
    };

    test("a forget on A reaches B as an archive, and 4 more rounds make no commits", async () => {
      const w = world();
      await keyed(w);
      const id = withStore(w.a, (s) => s.create({ title: "Deploy target", body: "fly.io" }).id);
      withStore(w.a, (s) => s.create({ title: "Keep me", body: "still here" }));
      await sync(w.a, opts);
      await sync(w.b, opts);
      assert.ok(byTitle(w.b, "Deploy target"), "B has the note");

      withStore(w.a, (s) => s.archive(id));
      await sync(w.a, opts); // A writes the marker: one commit
      const outB = await sync(w.b, opts);
      assert.match(outB, /archived 1 note that another computer archived/);
      const onB = byTitle(w.b, "Deploy target");
      assert.ok(onB, "B keeps the note (never a hard delete)");
      assert.ok(onB!.archived_at, "the forget reached B as an archive");
      assert.equal(onB!.body, "fly.io", "body kept");
      assert.equal(byTitle(w.b, "Keep me")?.archived_at ?? null, null);

      const before = commits(w.remote);
      for (let i = 0; i < 4; i++) {
        await sync(w.a, opts);
        await sync(w.b, opts);
      }
      assert.equal(commits(w.remote), before, "no ping-pong commits after the forget");
      assert.ok(byTitle(w.a, "Deploy target")!.archived_at, "still archived on A");
      assert.ok(byTitle(w.b, "Deploy target")!.archived_at, "still archived on B");
    });

    test("a hard delete on A becomes an archive on B, never a delete, and stops churning", async () => {
      const w = world();
      await keyed(w);
      const id = withStore(w.a, (s) => s.create({ title: "Old host", body: "render.com" }).id);
      await sync(w.a, opts);
      await sync(w.b, opts);
      withStore(w.a, (s) => s.delete(id));
      await sync(w.a, opts);
      await sync(w.b, opts);
      const onB = byTitle(w.b, "Old host");
      assert.ok(onB && onB.archived_at, "B archived it (never a delete)");
      assert.equal(onB!.body, "", "a hard delete takes the text out of the folder, so B's copy is emptied too (its history keeps it)");
      const before = commits(w.remote);
      for (let i = 0; i < 4; i++) {
        await sync(w.a, opts);
        await sync(w.b, opts);
      }
      assert.equal(commits(w.remote), before);
      assert.equal(byTitle(w.a, "Old host"), null, "A's delete stays a delete on A");
    });

    test("an edit on B made before the forget arrived wins: the note comes back on A, and A says so", async () => {
      const w = world();
      await keyed(w);
      const id = withStore(w.a, (s) => s.create({ title: "Cadence", body: "weekly" }).id);
      await sync(w.a, opts);
      await sync(w.b, opts);
      withStore(w.a, (s) => s.archive(id));
      await sync(w.a, opts);
      // B edits its copy before it syncs.
      withStore(w.b, (s) => {
        const n = s.exportAll().find((x) => x.title === "Cadence")!;
        s.update(n.id, { body: "every Thursday" });
      });
      const outB = await sync(w.b, opts);
      assert.match(outB, /kept 1 note/);
      assert.equal(byTitle(w.b, "Cadence")!.archived_at ?? null, null, "B keeps its edited note live");
      const outA = await sync(w.a, opts);
      assert.match(outA, /brought back 1 archived note/);
      const onA = byTitle(w.a, "Cadence")!;
      assert.equal(onA.archived_at ?? null, null, "A restored it");
      assert.equal(onA.body, "every Thursday");
      const before = commits(w.remote);
      const log: string[] = [];
      for (let i = 0; i < 3; i++) {
        log.push("A: " + (await sync(w.a, opts)));
        log.push("B: " + (await sync(w.b, opts)));
      }
      assert.equal(commits(w.remote), before);
    });

    test("restore on the computer that forgot it brings it back everywhere", async () => {
      const w = world();
      await keyed(w);
      const id = withStore(w.a, (s) => s.create({ title: "Port", body: "8080" }).id);
      await sync(w.a, opts);
      await sync(w.b, opts);
      withStore(w.a, (s) => s.archive(id));
      await sync(w.a, opts);
      await sync(w.b, opts);
      assert.ok(byTitle(w.b, "Port")!.archived_at);
      withStore(w.a, (s) => s.restore(id));
      await sync(w.a, opts);
      await sync(w.b, opts);
      assert.equal(byTitle(w.b, "Port")!.archived_at ?? null, null, "B brought it back");
      assert.equal(byTitle(w.a, "Port")!.archived_at ?? null, null, "A keeps it live");
      const before = commits(w.remote);
      for (let i = 0; i < 3; i++) {
        await sync(w.a, opts);
        await sync(w.b, opts);
      }
      assert.equal(commits(w.remote), before);
    });
  });
}

describe("edits settle", { skip }, () => {
  test("an edit on B reaches A and then nobody commits again (the applied edit keeps the file's time)", async () => {
    const w = world();
    withStore(w.a, (s) => s.create({ title: "Editable", body: "one" }));
    await sync(w.a);
    await sync(w.b);
    withStore(w.b, (s) => s.update(s.exportAll().find((x) => x.title === "Editable")!.id, { body: "two" }));
    await sync(w.b);
    await sync(w.a);
    assert.equal(byTitle(w.a, "Editable")!.body, "two");
    const before = commits(w.remote);
    for (let i = 0; i < 3; i++) {
      await sync(w.a);
      await sync(w.b);
    }
    assert.equal(commits(w.remote), before);
  });
});

describe("tombstone file format", { skip }, () => {
  test("the marker keeps the body and the content hash, so a 1.5 peer reading it sees no edit", async () => {
    const w = world();
    const id = withStore(w.a, (s) => s.create({ title: "Hash check", body: "body stays" }).id);
    await sync(w.a);
    const dir = join(w.a.repo, "monomem", "default");
    const file = join(dir, readdirSync(dir)[0]);
    const before = readFileSync(file, "utf8");
    withStore(w.a, (s) => s.archive(id));
    await sync(w.a);
    const after = readFileSync(file, "utf8");
    assert.match(after, /\narchived_at: "/);
    assert.match(after, /\narchived_by: "/);
    const hash = (t: string) => /\nhash: (".*")/.exec(t)![1];
    assert.equal(hash(after), hash(before), "hash unchanged");
    assert.ok(after.endsWith("---\nbody stays\n"), "body kept");
  });
});

describe("hard delete in a plain folder (r3 security S2)", () => {
  test("the tombstone keeps no text of a hard-deleted note, and the next export and import leave it alone", async () => {
    const { exportMarkdown, importMarkdown } = await import("../src/sync.js");
    const root = mkdtempSync(join(tmpdir(), "om-tomb-plain-"));
    roots.push(root);
    const vault = join(root, "vault");
    const s = new Store(join(root, "state.db"));
    try {
      const n = s.create({ title: "oops", body: "AWS secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY pasted by mistake" });
      exportMarkdown(s, vault);
      assert.equal(s.delete(n.id), true);
      exportMarkdown(s, vault);
      const files = (readdirSync(vault, { recursive: true }) as string[]).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(vault, f), "utf8"));
      assert.equal(files.length, 1, "the tombstone file stays, so the other computers learn about the delete");
      assert.match(files[0], /\narchived_at: "/);
      assert.ok(!files[0].includes("wJalrXUtnFEMI"), "the deleted text is gone from the folder");
      const again = exportMarkdown(s, vault);
      assert.deepEqual([again.written, again.skipped], [0, []], "a later export neither rewrites nor complains");
      const imp = await importMarkdown(s, vault);
      assert.equal(imp.counts.restored + imp.counts.created, 0, "importing our own tombstone does not bring the note back");
      assert.equal(s.exportAll().length, 0);
    } finally {
      s.close();
    }
  });
});
