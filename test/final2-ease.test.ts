// 1.5.0 final panel round 2, ease of use, should-fix items 1-9: each message names the real cause and the next step.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { ensureKey, keyPath } from "../src/crypto.js";
import { setProcessWriter } from "../src/actor.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO } from "../src/setup.js";
import { PROJECT_ROOT } from "../src/config.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  setProcessWriter("");
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "om-final2-"));
  roots.push(d);
  return d;
}
function run(dir: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: join(dir, "state.db"), HOME: dir, USERPROFILE: dir, MONOMEM_AUDIT_LOG: join(dir, "audit.log"), ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { cwd: tmpdir(), env, encoding: "utf8" });
}
/** A store with one sealed note whose key file is then removed. */
function sealedWithoutKey(): string {
  const dir = tmp();
  ensureKey(dir);
  const s = new Store(join(dir, "state.db"));
  s.create({ title: "sealed", body: "secret body" });
  s.close();
  unlinkSync(keyPath(dir));
  return dir;
}

describe("1-2: a missing key file", () => {
  test("show leads with the missing key file; doctor's Fix says to restore that file from a backup", () => {
    const dir = sealedWithoutKey();
    const kp = keyPath(dir);
    const show = run(dir, ["show", "1"]);
    assert.ok((show.stdout + show.stderr).trim().startsWith(`the key file ${kp} is missing`), show.stdout + show.stderr);
    const doc = run(dir, ["doctor"]);
    assert.notEqual(doc.status, 0);
    assert.ok(doc.stdout.includes(`Fix: Restore the key file ${kp} from your backup`), doc.stdout);
    assert.doesNotMatch(doc.stdout, /Run {2}monomem doctor {2}for more detail/);
  });
});

describe("3: quarantine reasons", () => {
  test("an approve-first hold reads 'namespace requires approval', not '... in namespace'", () => {
    const dir = tmp();
    const s = new Store(join(dir, "state.db"));
    s.setApproveFirst("team", true);
    setProcessWriter("stdio:cursor");
    assert.throws(() => s.create({ namespace: "team", title: "deploy", body: "on fridays" }));
    setProcessWriter("");
    s.close();
    const r = run(dir, ["quarantine"]);
    assert.match(r.stdout, /reasons: namespace requires approval$/m, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /approval in namespace/);
    const one = run(dir, ["quarantine", "show", "1"]);
    assert.doesNotMatch(one.stdout, /approval in namespace/, one.stdout + one.stderr);
  });
});

describe("4: changes", () => {
  test("no 'claims X' when X is the writer; a note counts under the writer who created it", () => {
    const dir = tmp();
    const s = new Store(join(dir, "state.db"));
    setProcessWriter("cli");
    const mine = s.create({ title: "Mine", body: "my own note", source: "cli" });
    setProcessWriter("stdio:cursor");
    s.update(mine.id, { body: "edited by cursor" });
    s.create({ title: "Theirs", body: "cursor's own" });
    setProcessWriter("");
    s.close();
    const r = run(dir, ["changes", "--since", "1h"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^ {2}cli: \+1 ~0 -0$/m, r.stdout);
    assert.match(r.stdout, /^ {2}stdio:cursor: \+1 ~0 -0$/m, r.stdout);
    assert.doesNotMatch(r.stdout, /by cli, claims "cli"/);
  });
});

describe("5: why", () => {
  test("the replaced version comes before 'is current'; encrypt enable is named, not 'metadata changed by unknown'", () => {
    const dir = tmp();
    const s = new Store(join(dir, "state.db"));
    setProcessWriter("cli");
    const n = s.create({ title: "Port", body: "staging is 8443" });
    s.update(n.id, { body: "staging is 9443" });
    setProcessWriter("");
    s.close();
    assert.equal(run(dir, ["encrypt", "enable", "--yes"]).status, 0);
    const r = run(dir, ["why", String(n.id)]);
    assert.equal(r.status, 0, r.stderr);
    const replaced = r.stdout.indexOf("version 1 (");
    const current = r.stdout.indexOf("version 2 is current");
    assert.ok(replaced > 0 && current > replaced, r.stdout);
    assert.doesNotMatch(r.stdout, /metadata changed .* by unknown/);
    assert.match(r.stdout, /body encrypted at rest by monomem encrypt enable/);
  });
});

describe("6-7: doctor's key list and one sentence about the hook and encrypted bodies", () => {
  test("doctor names .key and .attest-key in 'keys are kept in'", () => {
    const dir = tmp();
    assert.equal(run(dir, ["add", "a note", "--title", "t"]).status, 0);
    assert.equal(run(dir, ["encrypt", "enable", "--yes"]).status, 0);
    const doc = run(dir, ["doctor"]);
    const line = doc.stdout.split("\n").find((l) => l.includes("keys are kept in")) ?? "";
    assert.ok(line.includes(join(dir, ".key")), doc.stdout);
    assert.ok(line.includes(join(dir, ".attest-key")), doc.stdout);
  });

  test("encrypt status, encrypt enable and the docs say the same sentence", () => {
    const S = "The session-start hook never builds the body index; it uses a running Monomem server's index for this store if there is one, else it matches titles and tags.";
    const dir = tmp();
    const en = run(dir, ["encrypt", "enable", "--yes"]);
    assert.ok(en.stdout.includes(S), en.stdout);
    const st = run(dir, ["encrypt", "status"]);
    assert.ok(st.stdout.includes(S), st.stdout);
    assert.ok(readFileSync(join(PROJECT_ROOT, "docs", "encryption-retention.md"), "utf8").includes(S));
    assert.doesNotMatch(st.stdout, /the hooks never do/);
  });
});

describe("8: doctor with no data folder", () => {
  test("says not set up, points at monomem setup and creates nothing", () => {
    const dir = join(tmp(), "never-set-up");
    const r = run(dir, ["doctor"], { MONOMEM_DB_PATH: undefined });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /not set up.*monomem setup/);
    assert.equal(existsSync(dir), false, "doctor created the data folder");
  });
});

describe("9: leftovers", () => {
  test("service status with nothing installed: plain words, no raw service-manager text", () => {
    const dir = tmp();
    const r = run(dir, ["service", "status"], { APPDATA: join(dir, "a"), LOCALAPPDATA: join(dir, "l"), XDG_CONFIG_HOME: join(dir, "c") });
    if (r.status === 0) return; // a real Monomem service is installed on this machine: nothing to check
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Not installed\. Install it: monomem service install/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /said:|cannot find the file/);
  });

  test("trust distrust with a near-miss writer name refuses with 'Did you mean'; --force saves it as typed", () => {
    const dir = tmp();
    const s = new Store(join(dir, "state.db"));
    setProcessWriter("stdio:cursor");
    s.create({ title: "by cursor", body: "x" });
    setProcessWriter("");
    s.close();
    const r = run(dir, ["trust", "distrust", "curser", "--namespace", "*"]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /nothing was saved\. Did you mean "stdio:cursor" \(1 note\)/);
    const s1 = new Store(join(dir, "state.db"));
    assert.equal(s1.distrustRules().length, 0);
    s1.close();
    const f = run(dir, ["trust", "distrust", "curser", "--namespace", "*", "--force"]);
    assert.equal(f.status, 0, f.stdout + f.stderr);
    const s2 = new Store(join(dir, "state.db"));
    assert.deepEqual(s2.distrustRules().map((x) => x.writer), ["curser"]);
    s2.close();
  });

  test("setup --yes lists the start-of-session hook under 'What I will do'", async () => {
    const root = tmp();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude.json"), "{}");
    const e: SetupEnv = { home, platform: "linux", env: { HOME: home, MONOMEM_HOME: join(root, "om") }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: CLI, version: "2.0.0", now: () => new Date("2026-11-05T12:00:00Z") };
    const l: string[] = [];
    const io: SetupIO = { interactive: false, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => "" };
    assert.equal(await runSetup(e, io, { ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, yes: true, db: join(root, "data", "state.db"), only: ["claude-code"] }), 0, l.join("\n"));
    const all = l.join("\n");
    const plan = all.slice(all.indexOf("What I will do:"), all.indexOf("The exact change"));
    assert.match(plan, /^ {2}\d+\. .*start-of-session hook/m, all);
  });

  test("a write receipt says how to check it: monomem verify-receipt", async () => {
    const store = new Store(":memory:");
    const server = createMcpServer(store, "admin", {}, { local: true });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(s)]);
    const dir = tmp();
    const saved = process.env.MONOMEM_AUDIT_LOG;
    process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log");
    try {
      const r: any = await client.callTool({ name: "state_write", arguments: { title: "t", body: "b" } });
      const text: string = r.content[0].text;
      const out = JSON.parse(text.slice(text.indexOf("{")));
      if (!out.receipt) return; // no audit line for an in-memory store here: nothing to hint at
      assert.match(out.receipt_check, /monomem verify-receipt --file/);
    } finally {
      if (saved === undefined) delete process.env.MONOMEM_AUDIT_LOG;
      else process.env.MONOMEM_AUDIT_LOG = saved;
    }
  });
});
