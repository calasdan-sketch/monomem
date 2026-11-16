// Final release panel round 3 (1.5.0): the code should-fix items.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "om-final3-"));
  dirs.push(d);
  return d;
}
function run(dir: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db"), HOME: dir, USERPROFILE: dir, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: tmpdir(), env, encoding: "utf8" });
}

describe("EASE-SF1: no stray signing-key warning from the throwaway bench stores", () => {
  for (const cmd of ["demo", "drill", "health"]) {
    test(`${cmd}: stderr does not mention another store's signing key`, () => {
      const dir = tmp();
      if (cmd !== "demo") run(dir, ["add", "a note", "--body", "about forklifts"]);
      const r = run(dir, [cmd]);
      assert.doesNotMatch(r.stderr, /not replacing the signing key/, r.stderr);
    });
  }
});

describe("EASE-SF2: rollback --writer with a typo says Did you mean, like trust distrust", () => {
  test('"curser" suggests stdio:cursor instead of a silent "Nothing to do"', async () => {
    const { Store } = await import("../src/store.js");
    const { setProcessWriter } = await import("../src/actor.js");
    const { rollbackPreview } = await import("../src/rollback.js");
    const store = new Store(":memory:");
    try {
      const since = new Date(Date.now() - 1000).toISOString();
      setProcessWriter("stdio:cursor");
      store.create({ title: "from cursor" });
      store.create({ title: "again from cursor" });
      setProcessWriter("cli");
      const p = rollbackPreview(store, { scope: "admin" }, { writer: "curser", since });
      assert.deepEqual(p.actions, []);
      assert.deepEqual(p.did_you_mean, { writer: "stdio:cursor", notes: 2 });
      assert.match(p.warning, /stdio:cursor/);
    } finally {
      store.close();
    }
  });
});

describe("EASE-SF4: doctor says which apps are connected", () => {
  test("an installed app with no monomem entry is a warning, not All good", async () => {
    const { privateDir } = await import("../src/config.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = tmp();
    privateDir(join(dir, "data"));
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const env = { MONOMEM_HOME: join(dir, "data"), MONOMEM_DB_PATH: undefined, APPDATA: join(dir, "a"), LOCALAPPDATA: join(dir, "l"), XDG_CONFIG_HOME: join(dir, "c"), CLAUDE_CONFIG_DIR: undefined };
    const r = run(dir, ["doctor"], env);
    assert.match(r.stdout, /\[warn\].*no app is connected to Monomem.*Claude Code/, r.stdout);
    assert.doesNotMatch(r.stdout, /All good/);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { monomem: { command: "npx", args: ["-y", "monomem", "mcp"] } } }));
    const r2 = run(dir, ["doctor"], env);
    assert.match(r2.stdout, /\[info\] connected apps: Claude Code/, r2.stdout);
    assert.doesNotMatch(r2.stdout, /no app is connected/);
  });
});
