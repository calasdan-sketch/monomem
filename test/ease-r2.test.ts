// 1.5.0 round 2, ease of use (U-01 ... U-17): the CLI says what it hid, what it skipped, and the command to type next.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";
import { rollbackCli, type CliIO } from "../src/supersede-cli.js";
import { DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO, type SetupOptions } from "../src/setup.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
function run(dir: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "t.db"), ...extra },
    encoding: "utf8",
  });
}
function io(): CliIO & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (s) => lines.push(s), err: (s) => lines.push(s), ask: async () => "no", interactive: false };
}
function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "om-ease-r2-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** Two notes written by the local app "cursor" (stamped stdio:cursor), one by the person. */
function cursorStore(path: string): void {
  const s = new Store(path);
  try {
    setProcessWriter("stdio:cursor");
    s.create({ namespace: "work", title: "Deploy on Fridays", body: "always fine" });
    s.create({ namespace: "work", title: "Tabs", body: "use tabs" });
    setProcessWriter("cli");
    s.create({ namespace: "work", title: "Mine", body: "my own note" });
  } finally {
    s.close();
    setProcessWriter("");
  }
}

afterEach(() => setProcessWriter(""));

describe("U-01 writer names", () => {
  test("rollback for an app name suggests the stamped stdio:<app> name, prints no code, and fails", async () => {
    const store = new Store(":memory:");
    setProcessWriter("stdio:cursor");
    store.create({ title: "agent note", body: "x" });
    setProcessWriter("cli");
    const o = io();
    const code = await rollbackCli(store, ["--writer", "cursor", "--since", "1h"], o);
    const text = o.lines.join("\n");
    assert.equal(code, 1, text);
    assert.match(text, /Did you mean "stdio:cursor" \(1 note/);
    assert.doesNotMatch(text, /This code works once/);
    assert.doesNotMatch(text, /--yes/);
  });

  test("an empty rollback plan prints no code and no --yes line", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const o = io();
    const code = await rollbackCli(store, ["--writer", "token:nobody", "--since", "1h"], o);
    const text = o.lines.join("\n");
    assert.equal(code, 0);
    assert.match(text, /Nothing to do/);
    assert.doesNotMatch(text, /This code works once|--yes|Nothing is deleted/);
  });

  test("trust distrust <app> refuses, suggests stdio:<app>, and saves nothing", () =>
    withDir((dir) => {
      cursorStore(join(dir, "t.db"));
      const r = run(dir, ["trust", "distrust", "cursor", "--namespace", "*"]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /Did you mean "stdio:cursor" \(2 notes\)/);
      assert.match(r.stderr, /monomem trust distrust stdio:cursor --namespace '\*'/);
      const list = JSON.parse(run(dir, ["trust", "list", "--json"]).stdout);
      assert.deepEqual(list.distrust, []);
    }));

  test("a distrust label that matches nothing points at `monomem show <id>`, not recall", () =>
    withDir((dir) => {
      cursorStore(join(dir, "t.db"));
      const r = run(dir, ["trust", "distrust", "token:ci", "--namespace", "*"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /monomem show <id>/);
      assert.doesNotMatch(r.stdout, /recall --include-distrusted/);
    }));
});

describe("U-02 notes hidden by distrust are counted, and --include-distrusted works on ls and search", () => {
  test("ls says how many notes are hidden instead of 'No notes yet'; --include-distrusted shows them marked", () =>
    withDir((dir) => {
      cursorStore(join(dir, "t.db"));
      assert.equal(run(dir, ["trust", "distrust", "stdio:cursor", "--namespace", "*"]).status, 0);
      const ls = run(dir, ["ls"]);
      assert.equal(ls.status, 0, ls.stderr);
      assert.match(ls.stdout, /#3 /);
      assert.match(ls.stdout, /2 notes hidden because their writer is distrusted/);
      assert.match(ls.stdout, /ls --include-distrusted/);
      const all = run(dir, ["ls", "--include-distrusted"]);
      assert.equal(all.status, 0, all.stderr);
      assert.match(all.stdout, /#1 .*DISTRUSTED WRITER/);
      assert.doesNotMatch(all.stdout, /hidden because/);
      // Only distrusted notes left: never "No notes yet".
      const s = new Store(join(dir, "t.db"));
      s.captureDb().prepare("UPDATE notes SET archived_at = ? WHERE id = 3").run(new Date().toISOString());
      s.close();
      const empty = run(dir, ["ls"]);
      assert.doesNotMatch(empty.stdout, /No notes yet/);
      assert.match(empty.stdout, /2 notes hidden/);
      // search with no words lists through ls and takes the same option.
      assert.match(run(dir, ["search", "--include-distrusted"]).stdout, /#2 /);
    }));

  test("search says how many matching notes were hidden", () =>
    withDir((dir) => {
      cursorStore(join(dir, "t.db"));
      assert.equal(run(dir, ["trust", "distrust", "stdio:cursor", "--namespace", "*"]).status, 0);
      const r = run(dir, ["search", "Fridays", "deploy"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /1 matching note hidden because its writer is distrusted/);
      assert.match(r.stdout, /--include-distrusted/);
      const all = run(dir, ["search", "Fridays", "deploy", "--include-distrusted"]);
      assert.match(all.stdout, /#1 .*DISTRUSTED WRITER/);
    }));
});

describe("U-03 setup says plainly whether the start-of-session hook was installed", () => {
  // A fake Claude Code home in a temp dir: the real ~/.claude is never read or written.
  function sandbox(): { e: SetupEnv; settings: string; db: string; root: string } {
    const root = mkdtempSync(join(tmpdir(), "om-ease-setup-"));
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), '{"mcpServers":{"monomem":{"type":"stdio","command":"monomem","args":["mcp"]}}}');
    writeFileSync(join(home, ".claude", "settings.json"), '{"theme":"dark"}');
    return {
      root,
      settings: join(home, ".claude", "settings.json"),
      db: join(root, "data", "state.db"),
      e: { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: "/opt/monomem/dist/src/cli.js", version: "2.0.0", now: () => new Date("2026-11-14T12:00:00Z") },
    };
  }
  function sio(answers: string[] = [], interactive = false): SetupIO & { all: () => string } {
    const l: string[] = [];
    return { interactive, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => answers.shift() ?? "", all: () => l.join("\n") };
  }
  const sopts = (o: Partial<SetupOptions>): SetupOptions => ({ ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, ...o });
  const settingsOf = (p: string): any => JSON.parse(readFileSync(p, "utf8"));

  test("--yes installs the start-of-session hook and says how to skip or remove it", async () => {
    const s = sandbox();
    try {
      const out = sio();
      assert.equal(await runSetup(s.e, out, sopts({ yes: true, db: s.db })), 0, out.all());
      const after = settingsOf(s.settings);
      assert.match(JSON.stringify(after.hooks?.SessionStart ?? ""), /recall/);
      assert.equal(after.hooks.PostToolUse, undefined, "automatic memory still needs --capture");
      assert.match(out.all(), /Added: the start-of-session hook for Claude Code/);
      assert.match(out.all(), /monomem setup --yes --no-hook/);
      assert.match(out.all(), /monomem setup --undo/);
      assert.doesNotMatch(out.all(), /Not installed: start-of-session hook/);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("--yes --no-hook leaves it out and the last line says how to add it", async () => {
    const s = sandbox();
    try {
      const out = sio();
      assert.equal(await runSetup(s.e, out, sopts({ yes: true, hook: "no", db: s.db })), 0, out.all());
      assert.deepEqual(settingsOf(s.settings), { theme: "dark" });
      assert.match(out.all(), /Not installed: start-of-session hook\. Add it: monomem setup --hook/);
      assert.match(out.all().trim().split("\n").at(-1) ?? "", /Not installed: start-of-session hook/);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("a no at the terminal also ends with the Not installed line; the non-terminal refusal names --no-hook", async () => {
    const s = sandbox();
    try {
      const out = sio(["y", "n"], true);
      assert.equal(await runSetup(s.e, out, sopts({ db: s.db })), 0, out.all());
      assert.equal(settingsOf(s.settings).hooks, undefined);
      assert.match(out.all(), /Not installed: start-of-session hook\. Add it: monomem setup --hook/);
      const plain = sio();
      assert.equal(await runSetup(sandbox().e, plain, sopts({ db: s.db })), 1);
      assert.match(plain.all(), /--yes.*start-of-session hook.*--no-hook/s);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });
});
