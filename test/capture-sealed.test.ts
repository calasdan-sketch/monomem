// 1.5.0 S-02: with a key present, nothing the user typed (a prompt, a commit message, a command) reaches the data folder
// in plaintext through the capture path: capture note titles are fixed words, the text moves into the sealed body, no
// obs.concept tags are made from it, and spool lines are sealed. The test is a raw byte scan of every file in the folder.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { normalizeHookInput, recordEvent, spoolEvent, drainSpool, eventInput, SPOOL_FILE, type HookEvent } from "../src/capture.js";
import { distillSession } from "../src/extract.js";

const CANARIES = ["PROMPTCANARYZQX", "COMMITCANARYZQX", "TESTCMDCANARYZQX", "SPOOLCANARYZQX"];

/** Every canary found in the raw bytes of any file in the folder (db, -wal, -shm, spool, ...), with the file names. */
function scan(dir: string): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    const buf = readFileSync(p).toString("latin1");
    for (const c of CANARIES) if (buf.includes(c) || buf.includes(c.toLowerCase())) (hits[c] ??= []).push(f);
  }
  return hits;
}

type Step = [HookEvent, Record<string, unknown>];
const play = (s: Store, sid: string, steps: Step[]): void =>
  steps.forEach(([ev, raw], i) => recordEvent(s, normalizeHookInput(ev, { session_id: sid, cwd: "/w", ...raw }, new Date(Date.now() - 60_000 + i * 1000)), "default"));
const SESSION: Step[] = [
  ["user-prompt", { prompt: "We decided to always use PROMPTCANARYZQX as the staging db password." }],
  ["post-tool", { tool_name: "Bash", tool_input: { command: "npm test -- TESTCMDCANARYZQX" }, tool_response: { stdout: "ℹ fail 1" } }],
  ["post-tool", { tool_name: "Edit", tool_input: { file_path: "/w/a.ts" }, tool_response: {} }],
  ["post-tool", { tool_name: "Bash", tool_input: { command: "npm test -- TESTCMDCANARYZQX" }, tool_response: { stdout: "ℹ fail 0" } }],
  ["post-tool", { tool_name: "Bash", tool_input: { command: 'git commit -m "feat: add COMMITCANARYZQX support"' }, tool_response: { stdout: "[main 1] ok" } }],
  ["stop", {}],
];

describe("S-02a sealed capture notes", () => {
  test("key present: fixed titles, the text in the sealed body, no concept tags, no canary anywhere on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-s02a-"));
    let s: Store | undefined;
    try {
      ensureKey(dir);
      s = new Store(join(dir, "state.db"));
      play(s, "s1", SESSION);
      distillSession(s, "s1");
      distillSession(s, "s1"); // a rebuild keeps the same fixed summary title
      const notes = s.list({ kinds: ["observation", "summary"], limit: 50, order: "created_asc" }).notes;
      const dec = notes.find((n) => n.obs_type === "decision")!;
      assert.equal(dec.title, "Decision (sealed)");
      assert.match(dec.body, /PROMPTCANARYZQX/, "the sentence moved into the sealed body");
      assert.ok(notes.filter((n) => n.kind === "observation").every((n) => / \(sealed\)$/.test(n.title)), notes.map((n) => n.title).join(" | "));
      const sum = notes.find((n) => n.kind === "summary")!;
      assert.match(sum.title, /^Session \d{4}-\d{2}-\d{2}$/);
      assert.match(sum.body, /PROMPTCANARYZQX/, "the request is in the summary body");
      assert.match(sum.body, /Done: .*Decision: We decided/, "the summary still lists what was done, from the sealed bodies");
      assert.ok(notes.every((n) => n.encrypted === true));
      assert.ok(notes.every((n) => !n.tags.some((t) => t.startsWith("obs.concept:"))), "no concept tags from the text");
      const open = scan(dir);
      s.close();
      s = undefined;
      const closed = scan(dir);
      assert.deepEqual({ ...open, ...closed }, {}, "no canary in db, -wal or any other file");
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("no key: titles and concept tags as before", () => {
    const s = new Store(":memory:");
    play(s, "s1", SESSION);
    distillSession(s, "s1");
    const notes = s.list({ kinds: ["observation", "summary"], limit: 50 }).notes;
    assert.match(notes.find((n) => n.obs_type === "decision")!.title, /^Decision: We decided/);
    assert.match(notes.find((n) => n.kind === "summary")!.title, /^Session: We decided/);
    assert.ok(notes.some((n) => n.tags.some((t) => t.startsWith("obs.concept:"))));
    s.close();
  });
});

describe("S-02b sealed spool", () => {
  const ev = (input: string, sid = "late") => normalizeHookInput("user-prompt", { session_id: sid, cwd: "/w", prompt: input }, new Date(Date.now() - 60_000));
  const count = (s: Store): number => Number((s.captureDb().prepare("SELECT COUNT(*) AS n FROM capture_events").get() as { n: number }).n);

  test("a spooled line is sealed when a key exists; the drain stores it once; an old plain line still drains", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-s02b-"));
    let s: Store | undefined;
    try {
      const key = ensureKey(dir);
      assert.ok(spoolEvent(dir, { ...ev("SPOOLCANARYZQX my api key"), namespace: "default" }, key));
      const line = readFileSync(join(dir, SPOOL_FILE), "utf8");
      assert.deepEqual(scan(dir), {}, "no canary in the spool file");
      assert.match(line, /"sealed":"v2:/);
      // An old (pre-1.5.0) plain line next to it.
      writeFileSync(join(dir, SPOOL_FILE), JSON.stringify({ ...ev("plain old line", "old"), namespace: "default", spool_id: "old1" }) + "\n", { flag: "a" });
      s = new Store(join(dir, "state.db"));
      assert.equal(drainSpool(s, dir), 2);
      const rows = s.captureDb().prepare("SELECT seq, session_id, input, input_enc FROM capture_events ORDER BY seq").all() as Array<{ seq: number; session_id: string; input: string; input_enc: string | null }>;
      assert.deepEqual(rows.map((r) => eventInput(s!, r, r.session_id)), ["SPOOLCANARYZQX my api key", "plain old line"]);
      // The same sealed line again (a drain cut off after the insert): not stored twice.
      writeFileSync(join(dir, SPOOL_FILE), line);
      drainSpool(s, dir);
      assert.equal(count(s), 2, "exactly once");
      s.close();
      s = undefined;
      assert.deepEqual(scan(dir), {}, "no canary anywhere after the drain");
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("a sealed line moved under another spool id does not open (and is not stored); a respooled line stays sealed", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-s02b2-"));
    let s: Store | undefined;
    try {
      const key = ensureKey(dir);
      spoolEvent(dir, { ...ev("SPOOLCANARYZQX moved"), namespace: "default", spool_id: "aaa" }, key);
      const moved = JSON.parse(readFileSync(join(dir, SPOOL_FILE), "utf8")) as Record<string, unknown>;
      writeFileSync(join(dir, SPOOL_FILE), JSON.stringify({ ...moved, spool_id: "bbb" }) + "\n");
      s = new Store(join(dir, "state.db"));
      assert.equal(drainSpool(s, dir), 0);
      assert.equal(count(s), 0);
      assert.ok(existsSync(join(dir, SPOOL_FILE)), "kept for another try (dropped after the try limit)");
      assert.deepEqual(scan(dir), {});
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
