import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// Expert round fixes 1: regressions and gaps the round-4 verifier found.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { PROJECT_ROOT } from "../src/config.js";
import { setProcessWriter } from "../src/actor.js";
import { exportMarkdown, importMarkdown } from "../src/sync.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const roots: string[] = [];
const tmp = (p: string): string => {
  const d = mkdtempSync(join(tmpdir(), p));
  roots.push(d);
  return d;
};
afterEach(() => {
  setProcessWriter("");
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const cli = (home: string, args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, MONOMEM_HOME: home, ONEMEMORY_HOME: home, NO_COLOR: "1" },
    timeout: 60_000,
  });

describe("changes --since last with more than --limit changes", () => {
  test("prints every change and moves the marker, so the next run is empty", () => {
    const home = tmp("om-f1-feed-");
    const s = new Store(join(home, "state.db"));
    for (let i = 0; i < 25; i++) s.create({ title: `n${i}`, body: "b" });
    s.close();
    const entries = (out: string) => out.split("\n").filter((l) => /^[+~-] #\d+/.test(l)).length;
    const r1 = cli(home, ["changes", "--since", "last", "--limit", "10"]);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(entries(r1.stdout), 25, r1.stdout);
    const r2 = cli(home, ["changes", "--since", "last", "--limit", "10"]);
    assert.equal(entries(r2.stdout), 0, r2.stdout);
  });
});

describe("approving a held foreign sync create", () => {
  test("is linked to its origin (no duplicate on the next sync) and keeps imported_unverified", async () => {
    setProcessWriter("cli");
    const dir = tmp("om-f1-sync-");
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    try {
      a.create({ title: "Deploy steps from laptop", body: "run the zebrafish deploy" });
      exportMarkdown(a, dir);
      b.setApproveFirstAll(true);
      assert.equal((await importMarkdown(b, dir)).foreignHeld, 1);
      const q = b.listQuarantine()[0];
      const n = b.approveQuarantine(q.id);
      assert.equal(b.read(n.id)?.imported_unverified, true, "approval keeps the unverified flag");
      const r = await importMarkdown(b, dir);
      assert.equal(r.foreignHeld, 0, JSON.stringify(r.entries));
      assert.equal(b.listQuarantine().length, 0);
      assert.equal(b.list({}).total, 1, "no second copy");
    } finally {
      a.close();
      b.close();
    }
  });
  test("an approved foreign update keeps imported_unverified", async () => {
    setProcessWriter("cli");
    const dir = tmp("om-f1-sync-up-");
    const a = new Store(":memory:");
    const b = new Store(":memory:");
    try {
      const n = a.create({ title: "Shared note", body: "v1" });
      exportMarkdown(a, dir);
      await importMarkdown(b, dir);
      const local = b.search("Shared")[0];
      (b as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db.prepare("UPDATE notes SET imported_unverified = 0 WHERE id = ?").run(local.id);
      a.update(n.id, { body: "v2 edited" });
      exportMarkdown(a, dir);
      b.setApproveFirstAll(true);
      assert.equal((await importMarkdown(b, dir)).foreignHeld, 1);
      b.approveQuarantine(b.listQuarantine()[0].id);
      assert.equal(b.read(local.id)?.imported_unverified, true);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("setup: which legacy entry keeps its data", () => {
  test("an onememory entry with ONEMEMORY_DB_PATH and notes is kept over an empty claude-bridge", async () => {
    const { runSetup, DEFAULT_OPTIONS } = await import("../src/setup.js");
    const root = tmp("om-f1-setup-");
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const e = { home, platform: process.platform, env: { HOME: home }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "1.3.0", now: () => new Date("2026-11-09T12:00:00Z") };
    const opts = { ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, only: ["claude-code"], hook: "no" as const, capture: "no" as const } as typeof DEFAULT_OPTIONS;
    const oldDb = join(root, "old", "state.db");
    mkdirSync(join(root, "old"));
    const st = new Store(oldDb);
    st.create({ title: "kept", body: "x" });
    st.close();
    const file = join(home, ".claude.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { "claude-bridge": { command: "node", args: ["/x/claude-bridge/dist/src/mcp-stdio.js"] }, onememory: { command: "npx", args: ["-y", "onememory-mcp", "mcp"], env: { ONEMEMORY_DB_PATH: oldDb } } } }, null, 2));
    const l: string[] = [];
    const io = { interactive: false, out: (x: string) => void l.push(x), err: (x: string) => void l.push(x), ask: async () => "" };
    assert.equal(await runSetup(e, io, opts), 0, l.join("\n"));
    const j = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(j.mcpServers), ["monomem"]);
    assert.equal(j.mcpServers.monomem.env.MONOMEM_DB_PATH, oldDb);
    assert.equal(j.mcpServers.monomem.env.ONEMEMORY_DB_PATH, undefined);
  });
});

describe("MONOMEM_HOME quote and variable checks", () => {
  test("quotes are removed once; variables are refused only where a shell would expand them", async () => {
    const { resolveDataDir } = await import("../src/config.js");
    const root = tmp("om-f1-home-");
    const ok = (v: string, name = "MONOMEM_HOME") => resolveDataDir({ [name]: v }, root).dir;
    assert.equal(ok(`'${join(root, "s")}'`), join(root, "s"));
    assert.equal(ok(`  "${join(root, "q")}"  `), join(root, "q"));
    assert.equal(ok(`"${join(root, "o")}"`, "ONEMEMORY_HOME"), join(root, "o"));
    assert.throws(() => ok('""'), /MONOMEM_HOME is set but empty/);
    assert.throws(() => ok("' '"), /MONOMEM_HOME is set but empty/);
    assert.equal(ok(join(root, "data$foo")), join(root, "data$foo"), "$ inside a name is a real folder name");
    assert.throws(() => ok(`${root}/$HOME/x`), /is not a full path/);
    assert.throws(() => ok("%USERPROFILE%\\.monomem", "ONEMEMORY_HOME"), /ONEMEMORY_HOME=%USERPROFILE%\\\.monomem is not a full path/);
    assert.throws(() => ok(`"$HOME/.monomem"`), /is not a full path/, "quoted variable still refused");
  });
});
