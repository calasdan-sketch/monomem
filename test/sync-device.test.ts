// Device sync made easy: `monomem sync setup <git address | shared folder>`, then `monomem sync`.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { looksLikeRemote, readSyncConfig, runConfiguredSync, setupSync, startSyncTimer } from "../src/sync/device.js";
import { noteComputer } from "../src/sync/marks.js";
import { Store } from "../src/store.js";

const haveGit = spawnSync("git", ["--version"]).status === 0;
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const GITENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "", GIT_CONFIG_NOSYSTEM: "1" } as NodeJS.ProcessEnv;

interface Dev {
  dataDir: string;
  dbPath: string;
}
function world() {
  const root = mkdtempSync(join(tmpdir(), "om-dev-"));
  roots.push(root);
  const dev = (n: string): Dev => ({ dataDir: join(root, n, "data"), dbPath: join(root, n, "data", "state.db") });
  return { root, a: dev("a"), b: dev("b"), shared: join(root, "OneDrive", "Monomem") };
}
function io() {
  const lines: string[] = [];
  return { lines, interactive: false, out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l), ask: async () => "", text: () => lines.join("\n") };
}
const withStore = <T>(d: Dev, fn: (s: Store) => T): T => {
  mkdirSync(d.dataDir, { recursive: true });
  const s = new Store(d.dbPath);
  try {
    return fn(s);
  } finally {
    s.close();
  }
};
const env = (d: Dev) => ({ dataDir: d.dataDir, dbPath: d.dbPath, env: GITENV });
async function setup(d: Dev, target: string, extra: { auto?: boolean; name?: string } = {}): Promise<string> {
  const x = io();
  const code = await setupSync(x, { ...env(d), target, ...extra });
  assert.equal(code, 0, x.text());
  return x.text();
}
async function sync(d: Dev): Promise<string> {
  const x = io();
  const code = await runConfiguredSync(x, env(d));
  assert.equal(code, 0, x.text());
  return x.text();
}
const copyKey = (from: Dev, to: Dev): void => {
  mkdirSync(to.dataDir, { recursive: true });
  copyFileSync(join(from.dataDir, ".sync-key"), join(to.dataDir, ".sync-key"));
};
const snapshot = (dir: string): string =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${e.name}:${readFileSync(join(e.parentPath, e.name), "utf8")}`)
    .sort()
    .join("|");

describe("sync setup: a shared folder (OneDrive, Dropbox, ...)", () => {
  test("two computers share notes through a folder; every file is sealed; the source computer is shown; forget travels; it settles", async () => {
    const w = world();
    withStore(w.a, (s) => s.create({ title: "Deploy target", body: "fly.io secret-ish words" }));
    const out = await setup(w.a, w.shared, { name: "Work laptop" });
    assert.match(out, /Copy the key file/);
    assert.match(out, /NEVER put it in the sync folder/);
    assert.equal(readSyncConfig(w.a.dataDir)?.auto, false, "the timer is off by default");
    // Nothing readable in the shared folder: no title, no body, no computer name.
    const all = snapshot(w.shared);
    assert.ok(!/Deploy|fly\.io|Work laptop/.test(all), "the shared folder holds only sealed files");
    assert.ok(!readdirSync(w.shared, { recursive: true }).map(String).some((f) => f.includes("sync-key")), "the key never goes in the folder");

    copyKey(w.a, w.b);
    await setup(w.b, w.shared);
    const onB = withStore(w.b, (s) => s.exportAll().find((n) => n.title === "Deploy target"));
    assert.ok(onB, "the note reached B");
    assert.equal(withStore(w.b, (s) => noteComputer(s, onB!.id)), "Work laptop", "B shows which computer the note came from");
    assert.equal(withStore(w.a, (s) => noteComputer(s, 1)), null, "a note written here has no 'from computer'");

    withStore(w.a, (s) => s.archive(s.exportAll().find((n) => n.title === "Deploy target")!.id));
    await sync(w.a);
    assert.match(await sync(w.b), /archived 1 note/);
    assert.ok(withStore(w.b, (s) => s.exportAll().find((n) => n.title === "Deploy target")!.archived_at));
    await sync(w.a);
    const settled = snapshot(w.shared);
    for (let i = 0; i < 3; i++) {
      await sync(w.a);
      await sync(w.b);
    }
    assert.equal(snapshot(w.shared), settled, "no file changes once both computers are level");
  });

  test("edited on both computers: a dispute, not a silent overwrite: the other text is held for a person to pick", async () => {
    const w = world();
    withStore(w.a, (s) => s.create({ title: "Port", body: "8080" }));
    await setup(w.a, w.shared);
    copyKey(w.a, w.b);
    await setup(w.b, w.shared);
    const edit = (d: Dev, body: string): void => withStore(d, (s) => void s.update(s.exportAll().find((n) => n.title === "Port")!.id, { body }));
    edit(w.b, "9090 from B");
    await new Promise((r) => setTimeout(r, 20)); // A edits later: A is newer
    edit(w.a, "7070 from A");
    await sync(w.a);
    const out = await sync(w.b);
    assert.match(out, /held for you to pick/);
    const held = withStore(w.b, (s) => s.listQuarantine());
    assert.equal(held.length, 1);
    assert.equal(held[0].body, "9090 from B", "B's own text waits, nothing is lost");
    assert.equal(withStore(w.b, (s) => s.exportAll().find((n) => n.title === "Port")!.body), "7070 from A");
    const again = await sync(w.b);
    assert.doesNotMatch(again, /held for you/, "held once, not on every sync");
    withStore(w.b, (s) => s.approveQuarantine(held[0].id));
    assert.equal(withStore(w.b, (s) => s.exportAll().find((n) => n.title === "Port")!.body), "9090 from B", "approving picks it");
  });

  test("a sync tool's conflict copy is skipped and named, not a reason to stop", async () => {
    const w = world();
    withStore(w.a, (s) => s.create({ title: "x", body: "y" }));
    await setup(w.a, w.shared);
    const vault = join(w.shared, "monomem-enc");
    const one = readdirSync(vault).find((f) => f.endsWith(".enc"))!;
    copyFileSync(join(vault, one), join(vault, one.replace(".enc", " (Work laptop's conflicted copy).enc")));
    const out = await sync(w.a);
    assert.match(out, /skipped .*conflicted copy.*not a file Monomem wrote/);
  });

  test("the second computer without the key is told to copy it, and nothing changes", async () => {
    const w = world();
    withStore(w.a, (s) => s.create({ title: "x", body: "y" }));
    await setup(w.a, w.shared);
    const x = io();
    assert.equal(await setupSync(x, { ...env(w.b), target: w.shared }), 1);
    assert.match(x.text(), /no key at .*Copy the key file/);
  });

  test("a bare `monomem sync` before setup says how to set it up", async () => {
    const w = world();
    const x = io();
    assert.equal(await runConfiguredSync(x, env(w.a)), 1);
    assert.match(x.text(), /monomem sync setup/);
  });

  test("--auto on is saved; the timer starts only then", async () => {
    const w = world();
    const logs: string[] = [];
    startSyncTimer(w.a.dataDir, () => ({ command: process.execPath, args: ["-e", "0"] }), (l) => void logs.push(l));
    assert.equal(logs.length, 0, "no setup: no timer");
    await setup(w.a, w.shared, { auto: true });
    assert.equal(readSyncConfig(w.a.dataDir)?.auto, true);
    startSyncTimer(w.a.dataDir, () => ({ command: process.execPath, args: ["-e", "0"] }), (l) => void logs.push(l));
    assert.match(logs.join("\n"), /device sync every 30 min/);
    await setup(w.a, "", { auto: false });
    assert.equal(readSyncConfig(w.a.dataDir)?.auto, false, "turned off without naming the folder again");
  });
});

describe("sync setup: a private git address", { skip: !haveGit ? "git is not installed" : false }, () => {
  test("clone once, sealed files, the other computer sees the note and where it came from", async () => {
    const w = world();
    const remote = join(w.root, "remote.git");
    mkdirSync(remote);
    spawnSync("git", ["init", "--bare", "-b", "main"], { cwd: remote });
    const url = pathToFileURL(remote).href;
    assert.ok(looksLikeRemote(url));
    withStore(w.a, (s) => s.create({ title: "Cadence", body: "Thursdays" }));
    await setup(w.a, url, { name: "Desk PC" });
    copyKey(w.a, w.b);
    await setup(w.b, url);
    const n = withStore(w.b, (s) => s.exportAll().find((x) => x.title === "Cadence"));
    assert.ok(n);
    assert.equal(withStore(w.b, (s) => noteComputer(s, n!.id)), "Desk PC");
    const files = spawnSync("git", ["ls-files"], { cwd: join(w.a.dataDir, "sync-repo"), encoding: "utf8" }).stdout;
    assert.match(files, /monomem-enc\/[0-9a-f]{32}\.enc/);
    assert.match(files, /monomem-enc\/[0-9a-f]{32}\.mach/, "the computer label travels sealed");
    assert.doesNotMatch(files, /monomem\//);
  });

  test("an address with a password inside is refused", async () => {
    const w = world();
    const x = io();
    assert.equal(await setupSync(x, { ...env(w.a), target: "https://user:hunter2@example.com/me/notes.git" }), 1);
    assert.match(x.text(), /password or token/);
    assert.doesNotMatch(x.text(), /hunter2/);
  });
});

test("looksLikeRemote: addresses vs folders", () => {
  assert.ok(looksLikeRemote("https://github.com/me/notes.git"));
  assert.ok(looksLikeRemote("git@github.com:me/notes.git"));
  assert.ok(looksLikeRemote("ssh://git@host/x.git"));
  assert.ok(!looksLikeRemote("C:\\Users\\me\\OneDrive\\Monomem"));
  assert.ok(!looksLikeRemote("/home/me/Dropbox/monomem"));
});
