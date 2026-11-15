// 1.5.0 round 2, ease of use (U-01 ... U-17): the CLI says what it hid, what it skipped, and the command to type next.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";
import { rollbackCli, type CliIO } from "../src/supersede-cli.js";

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
