// Integration of the trust lane into the session lane's pushes: session start and the prompt step show the echo label
// (store/taint.ts echoOf) and the overwrite notice (store/overwrites.ts), which catch_up and the note fields already carried.
import "./setup-env.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { receiptAdd } from "../src/receipts.js";
import { promptStep } from "../src/prompt/step.js";
import { hookSelfWriter, injectContext } from "../src/context-inject.js";
import { runRecall } from "../src/recall.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const noGit = { branch: "", diffFiles: [] };
const PAGE = "Acme raised the price of the pro plan to forty dollars per seat per month starting in January";
const PARAPHRASE = "Note: the Acme pro plan price rises to forty dollars per seat per month, starting January";
afterEach(() => setProcessWriter(""));

function prompt(s: Store, sid: string, at: Date): void {
  recordEvent(s, normalizeHookInput("user-prompt", { session_id: sid, cwd: "/work/proj", prompt: "hi" }, at), "default");
}

/** An echo written by a local stdio writer whose session start showed the original. */
function withEcho(s: Store): { orig: number; echo: number } {
  const orig = as("claude-code", () => s.create({ title: "acme pricing", body: PAGE })).id;
  s.db.prepare("INSERT INTO sessions (id, namespace, cwd, started_at) VALUES (?, ?, ?, ?)").run("sess-e", "default", "/work/proj", new Date().toISOString());
  receiptAdd(s, { sessionId: "sess-e", namespace: "default", client: "stdio", shown: [{ id: orig, why: "decision", tokens: 20 }] });
  setProcessWriter("stdio");
  const echo = actorStore.run({ label: "", authed: false, cwd: "/work/proj" }, () => s.create({ title: "acme price", body: PARAPHRASE }));
  setProcessWriter("");
  assert.equal(echo.echo_of, orig);
  return { orig, echo: echo.id };
}

test("session start shows the echo label on the restating note", async () => {
  const s = new Store(":memory:");
  try {
    const { orig, echo } = withEcho(s);
    const text = await injectContext(s, { signals: noGit });
    const line = text.split("\n").find((l) => l.includes(`#${echo} `)) ?? "";
    assert.match(line, new RegExp(`echo of #${orig}: restates a note this writer was shown; not a second source`), text);
  } finally {
    s.close();
  }
});

test("the prompt step's new-notes list shows the echo label", () => {
  const s = new Store(":memory:");
  try {
    prompt(s, "sess-p", new Date(Date.now() - 60_000));
    const { orig } = withEcho(s);
    prompt(s, "sess-p", new Date());
    const r = promptStep(s, "sess-p", "hi", { recall: false });
    assert.match(r.text, new RegExp(`echo of #${orig}`), r.text);
  } finally {
    s.close();
  }
});

test("the prompt step says once that another writer replaced this agent's text; nothing for its own edits", () => {
  const s = new Store(":memory:");
  try {
    const n = as("claude", () => s.create({ title: "deploy target", body: "we deploy to fly.io" }));
    prompt(s, "sess-o", new Date(Date.now() - 60_000));
    as("codex", () => s.update(n.id, { body: "we deploy to render.com" }));
    prompt(s, "sess-o", new Date(Date.now() + 1000));
    const r = promptStep(s, "sess-o", "hi", { recall: false, self: "claude" });
    assert.match(r.text, new RegExp(`Another writer replaced text you wrote[^\\n]*\\n#${n.id} "deploy target" by codex`), r.text);
    // No writer known: no notice. The writer who made the change: no notice either.
    assert.doesNotMatch(promptStep(s, "sess-o", "hi", { recall: false }).text, /Another writer replaced/);
    assert.doesNotMatch(promptStep(s, "sess-o", "hi", { recall: false, self: "codex" }).text, /Another writer replaced/);
    // The next prompt: the window moved on, so it is not said again.
    prompt(s, "sess-o", new Date(Date.now() + 2000));
    assert.doesNotMatch(promptStep(s, "sess-o", "hi", { recall: false, self: "claude" }).text, /Another writer replaced/);
  } finally {
    s.close();
  }
});

test("session start (the hook's recall) shows the overwrite notice for this app's writer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-notices-"));
  const dbPath = join(dir, "state.db");
  try {
    const s = new Store(dbPath);
    const n = as("claude", () => s.create({ title: "deploy target", body: "we deploy to fly.io" }));
    as("codex", () => s.update(n.id, { body: "we deploy to render.com" }));
    s.close();
    const out = JSON.parse(await runRecall({ dbPath, cwd: dir, budgetMs: 0, selfWriter: "claude", signals: noGit }));
    const ctx: string = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, new RegExp(`Another writer replaced text you wrote[^\\n]*\\n#${n.id} "deploy target" by codex`), ctx);
    const other = JSON.parse(await runRecall({ dbPath, cwd: dir, budgetMs: 0, selfWriter: "cursor", signals: noGit }));
    assert.doesNotMatch(other.hookSpecificOutput.additionalContext, /Another writer replaced/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hookSelfWriter: MONOMEM_CLIENT first, then Claude Code's own label, else unknown", () => {
  assert.equal(hookSelfWriter({ MONOMEM_CLIENT: "cursor" }), "stdio:cursor");
  assert.equal(hookSelfWriter({ CLAUDECODE: "1" }), "stdio:claude-code");
  assert.equal(hookSelfWriter({ CLAUDE_PROJECT_DIR: "/x" }), "stdio:claude-code");
  assert.equal(hookSelfWriter({}), undefined);
});
