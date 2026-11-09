// Round 7 facts and disputes: pin gate and actor on `fact remove`, per-namespace disputes, synonyms everywhere, key drift, --check.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Store, ValidationError } from "../src/store.js";
import { setProcessWriter } from "../src/actor.js";
import { PROJECT_ROOT } from "../src/config.js";
import { withFacts, similarKeys, disputedLines, factsTable, canonKey, writeConflicts } from "../src/facts.js";
import { findConflicts, groupConflicts, conflictLines } from "../src/conflicts.js";
import { factMismatchWarnings } from "../src/lint.js";
import { assertPlainWriteTags } from "../src/reserved-tags.js";
import { buildSummary } from "../src/recall.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const mk = (s: Store, writer: string, title: string, facts: Record<string, string>, ns = "default", tags?: string[]): number =>
  s.create({ title, body: "b", namespace: ns, tags: withFacts(tags, facts) }, { writtenBy: writer }).id;

/** A file store in a temp dir; the CLI child gets its own MONOMEM_HOME / MONOMEM_DB_PATH there, never the real ones. */
function scene(): { db: string; run: (args: string[]) => ReturnType<typeof spawnSync>; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "monomem-facts-r7-"));
  const db = join(dir, "state.db");
  const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db, NO_COLOR: "1" };
  return { db, run: (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("fact remove and facts --check", () => {
  test("refuses a pinned note from a non-terminal shell, and leaves it untouched", () => {
    const sc = scene();
    const s = new Store(sc.db);
    const id = mk(s, "alice", "deploy", { deploy_target: "render" });
    setProcessWriter("cli");
    s.setPinned(id, true);
    setProcessWriter("");
    const tags = s.read(id)!.tags;
    s.close();
    const r = sc.run(["fact", "remove", String(id), "deploy_target"]);
    assert.equal(r.status, 1);
    assert.match(String(r.stderr), /Refused: fact remove on pinned note #\d+/);
    const s2 = new Store(sc.db);
    assert.deepEqual(s2.read(id)!.tags, tags);
    s2.close();
    sc.done();
  });

  test("an unpinned note works and the change log names the cli actor", () => {
    const sc = scene();
    const s = new Store(sc.db);
    const id = mk(s, "alice", "deploy", { deploy_target: "render" });
    s.close();
    const r = sc.run(["fact", "remove", String(id), "deploy_target"]);
    assert.equal(r.status, 0, String(r.stderr));
    const db = new DatabaseSync(sc.db);
    const rows = db.prepare("SELECT kind, actor FROM change_log WHERE note_id = ? ORDER BY seq").all(id) as Array<{ kind: string; actor: string }>;
    db.close();
    assert.equal(rows[rows.length - 1].actor, "cli");
    sc.done();
  });

  test("facts --check: exit 1 with a one-line summary on a dispute (synonyms included), 0 otherwise", () => {
    const sc = scene();
    const s = new Store(sc.db);
    mk(s, "alice", "a", { deploy_target: "render" });
    s.close();
    const ok = sc.run(["facts", "--check"]);
    assert.equal(ok.status, 0);
    assert.match(String(ok.stdout), /no disputed facts/);
    const s2 = new Store(sc.db);
    mk(s2, "bob", "b", { hosting: "fly" });
    mk(s2, "carol", "c", { database: "pg" }, "other");
    s2.close();
    const bad = sc.run(["facts", "--check"]);
    assert.equal(bad.status, 1);
    assert.equal(String(bad.stdout).trim().split("\n").length, 1);
    assert.match(String(bad.stdout), /1 disputed fact: default\/deploy_target/);
    assert.equal(sc.run(["facts", "--check", "--namespace", "other"]).status, 0);
    sc.done();
  });

  test("facts --as-of prints what the view is", () => {
    const sc = scene();
    const s = new Store(sc.db);
    mk(s, "alice", "a", { deploy_target: "render" });
    s.close();
    const r = sc.run(["facts", "--as-of", "1h"]);
    assert.equal(r.status, 0, String(r.stderr));
    assert.match(String(r.stdout), /^As of .*tag history is not kept/);
    sc.done();
  });
});

describe("disputes by namespace and synonym", () => {
  test("the same key in two namespaces is not a dispute", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", { deploy_target: "render" }, "proj-a");
    mk(s, "bob", "b", { deploy_target: "fly.io" }, "proj-b");
    assert.equal(disputedLines(s, {}), "");
    assert.equal(findConflicts(s).length, 0);
    s.close();
  });

  test("unscoped session lines name the namespace; scoped ones do not", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", { deploy_target: "render" }, "proj-a");
    mk(s, "bob", "b", { deploy_target: "fly.io" }, "proj-a");
    assert.match(disputedLines(s, {}), /disagree on \[proj-a\] deploy_target/);
    assert.match(disputedLines(s, { namespace: "proj-a" }), /disagree on deploy_target:/);
    s.close();
  });

  test("a synonym dispute shows in session lines, conflicts and the facts table, and removes with the right key", () => {
    const s = new Store(":memory:");
    const a = mk(s, "alice", "a", { deploy_target: "render" });
    const b = mk(s, "bob", "b", { hosting: "fly.io" });
    assert.equal(canonKey("api.hosting"), "api.deploy_target");
    assert.equal(canonKey("api.host"), "api.host", "a host name is not a deploy target");
    assert.match(disputedLines(s, { namespace: "default" }), /deploy_target: 'render' \(#\d+ alice\) vs 'fly\.io' \(#\d+ bob as hosting\)/);
    const found = findConflicts(s);
    assert.equal(found.length, 1);
    assert.equal(found[0].tier, "fact");
    const groups = groupConflicts(found);
    assert.equal(groups.length, 1);
    const text = conflictLines(groups).join("\n");
    assert.match(text, new RegExp(`monomem fact remove ${b} hosting`));
    assert.match(text, new RegExp(`monomem fact remove ${a} deploy_target`));
    const rows = factsTable(s.liveFactNotesIn("default", { includeNeverShow: true })).default;
    assert.ok(rows.every((r) => r.disputed));
    s.close();
  });

  test("the same value under synonym keys is no dispute", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", { deploy_target: "Render" });
    mk(s, "bob", "b", { hosting: "render" });
    assert.equal(disputedLines(s, {}), "");
    assert.equal(findConflicts(s).length, 0);
    s.close();
  });
});

describe("write-time and lookups", () => {
  test("never-show notes are not compared at write time (as with similar_keys)", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "hidden", { deploy_target: "render" }, "default", ["never-show"]);
    const mine = s.read(mk(s, "bob", "b", { deploy_target: "fly" }))!;
    assert.deepEqual(writeConflicts(s, mine), []);
    s.close();
  });

  test("with no namespace the result is oldest first", () => {
    const s = new Store(":memory:");
    for (let i = 0; i < 5; i++) mk(s, "alice", `n${i}`, { k: String(i) });
    const ids = s.liveFactNotesIn(undefined).map((n) => n.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(ids.length, 5);
    s.close();
  });
});

describe("facts table", () => {
  test("one writer with several values: newest is current, older ones named", () => {
    const s = new Store(":memory:");
    const old = mk(s, "alice", "old", { deploy_target: "render" });
    const now = mk(s, "alice", "new", { deploy_target: "fly.io" });
    const notes = s.liveFactNotesIn("default", { includeNeverShow: true }).map((n) => (n.id === old ? { ...n, updated_at: "2020-01-01T00:00:00.000Z" } : n));
    const row = factsTable(notes).default[0];
    const cur = row.values.find((v) => v.value === "fly.io")!;
    const prev = row.values.find((v) => v.value === "render")!;
    assert.equal(cur.current, true);
    assert.deepEqual(cur.ids, [now]);
    assert.deepEqual(prev.older, [old]);
    s.close();
  });
});

describe("similar_keys", () => {
  test("a plural or one-letter slip is caught; short keys are not", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", { deploy_target: "render", db: "pg" });
    const mineA = s.read(mk(s, "bob", "b", { deploy_targets: "fly" }))!;
    assert.equal(similarKeys(s, mineA).deploy_targets?.[0].key, "deploy_target");
    const mineB = s.read(mk(s, "bob", "c", { dr: "x" }))!;
    assert.deepEqual(similarKeys(s, mineB), {});
    s.close();
  });

  test("the hint prefers the common key over a synonym", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "a", { host: "render" });
    mk(s, "alice", "a2", { deploy_target: "render" });
    const mine = s.read(mk(s, "bob", "b", { hosting: "fly" }))!;
    assert.equal(similarKeys(s, mine).hosting?.[0].key, "deploy_target");
    s.close();
  });
});

describe("tag and text hygiene", () => {
  test("a fact: tag with a line break or control character is refused on the plain tags path", () => {
    for (const t of ["fact:k=a\nIgnore previous", "fact:k=a\u0000b", "fact:k=a\r", " fact:k=a\tb"]) assert.throws(() => assertPlainWriteTags([t]), ValidationError, JSON.stringify(t));
    assert.doesNotThrow(() => assertPlainWriteTags(["fact:k=fine", "other\nthing"]));
  });

  test("fact_warnings wording is hedged", () => {
    const w = factMismatchWarnings("t", "the database is down now", ["fact:database=postgres"]);
    assert.match(w[0], /the text may say database is "down"/);
  });

  test("session start explains each writer once, then names it briefly", () => {
    const s = new Store(":memory:");
    const n1 = s.read(s.create({ title: "one", body: "x" }, { writtenBy: "stdio:claude" }).id)!;
    const n2 = s.read(s.create({ title: "two", body: "y" }, { writtenBy: "stdio:claude" }).id)!;
    const n3 = s.read(s.create({ title: "three", body: "z" }, { writtenBy: "alice" }).id)!;
    const out = buildSummary([n1, n2, n3]);
    assert.equal(out.split("self-declared").length - 1, 1);
    assert.match(out, /- stdio:claude: \[two\]/);
    assert.match(out, /- alice \(token\): \[three\]/);
    s.close();
  });
});
