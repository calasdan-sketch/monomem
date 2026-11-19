// Round 2: plain-language wording, doctor creating nothing, scope messages, tidy edges cap.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.js";
import { edgesTooBigMessage, EDGES_HARD_CAP_PAIRS } from "../src/edges-cap.js";
import { autoScopeName } from "../src/namespace.js";
import { liveRepoForProject } from "../src/cli/scope.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const tmp = (): string => mkdtempSync(join(tmpdir(), "monomem-r2w-"));
const cli = (args: string[], dataDir: string, env: Record<string, string> = {}, cwd?: string) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, NO_COLOR: "1", MONOMEM_HOME: dataDir, MONOMEM_DB_PATH: join(dataDir, "state.db"), MONOMEM_AUTO_SCOPE: "", MONOMEM_TOKEN: "", ...env },
  });

describe("tidy edges cap", () => {
  test("small jobs pass, huge ones are refused in plain words", () => {
    assert.equal(edgesTooBigMessage(1000, 400_000), null);
    assert.equal(edgesTooBigMessage(1000, EDGES_HARD_CAP_PAIRS), null);
    const m = edgesTooBigMessage(20000, 151_000_000)!;
    assert.match(m, /Too big to do in one go: 20,000 notes/);
    assert.match(m, /Nothing was changed/);
    assert.match(m, /--all --yes/);
    assert.doesNotMatch(m, /similarity/i);
  });
});

describe("scope wording", () => {
  test("empty store: says new stores start ON after setup, not 'default for stores that already have notes'", () => {
    const dir = tmp();
    const repoDir = join(dir, "r");
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    const r = cli(["scope", "status"], join(dir, "data"), {}, repoDir);
    assert.match(r.stdout, /new stores start with it ON after `monomem setup`/);
    assert.doesNotMatch(r.stdout, /default for stores that already have notes/);
  });

  test("liveRepoForProject finds a sibling repo that still exists", () => {
    const parent = tmp();
    const old = join(parent, "oldrepo");
    const me = join(parent, "newrepo");
    mkdirSync(join(old, ".git"), { recursive: true });
    mkdirSync(join(me, ".git"), { recursive: true });
    assert.equal(liveRepoForProject(me, autoScopeName(old)), old);
    assert.equal(liveRepoForProject(me, "gone-aaaaaa"), null);
  });
});

describe("doctor creates nothing on a fresh folder", () => {
  test("no .token and no .attest-key afterwards", () => {
    const dir = join(tmp(), "data");
    mkdirSync(dir, { recursive: true });
    const r = cli(["check", "--setup"], dir);
    assert.ok(r.status === 0 || r.status === 1, r.stderr);
    const names = readdirSync(dir);
    assert.ok(!names.includes(".token"), `unexpected files: ${names.join(", ")}`);
    assert.ok(!names.some((n) => n.startsWith(".attest-key")), `unexpected files: ${names.join(", ")}`);
    assert.ok(!existsSync(join(dir, ".token")));
  });
});

describe("export without --format", () => {
  test("--out alone says --format json is needed", () => {
    const dir = tmp();
    const r = cli(["export", "--out", join(dir, "x.json")], join(dir, "data"));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--out needs --format json/);
  });
});

describe("path too long", () => {
  test("a long data path gives the length message, not the read-only one", { skip: process.platform !== "win32" }, () => {
    const dir = tmp();
    const long = join(dir, "a".repeat(120), "b".repeat(120), "state.db");
    const r = cli(["ls"], dir, { MONOMEM_DB_PATH: long });
    assert.match(r.stdout + r.stderr, /the folder path is too long \(\d+ characters; Windows allows 259\)/);
    assert.doesNotMatch(r.stdout + r.stderr, /Docker/);
  });
});
