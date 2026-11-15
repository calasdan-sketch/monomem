// `monomem import --from claude-code-chats`: past Claude Code conversations become searchable notes, each message stored
// with the message it replied to (so a search for the question also finds the answer). The same chatNotes() builds the
// notes for the LoCoMo retrieval benchmark, so the benchmark measures exactly what the import stores.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKey } from "../src/crypto.js";
import { CHAT_TAG, SEALED_CHAT_TITLE, chatNotes, readClaudeCodeChats, REPLY_CONTEXT_CHARS } from "../src/chat-import.js";
import { injectContext, rankContext } from "../src/context-inject.js";
import { FOREIGN_SOURCES, runForeignImport, tagFor } from "../src/foreign-import.js";
import { Store } from "../src/store.js";

describe("chatNotes", () => {
  test("each message carries the message it replied to; the first has none", () => {
    const notes = chatNotes([
      { id: "1", speaker: "User", text: "Which port does staging use?" },
      { id: "2", speaker: "Claude", text: "Staging listens on 9443." },
    ]);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].title, "User: Which port does staging use?");
    assert.equal(notes[0].body, "Which port does staging use?");
    assert.equal(notes[1].title, "Claude: Staging listens on 9443.");
    assert.match(notes[1].body, /^Staging listens on 9443\.\n\n\(replying to User: Which port does staging use\?\)$/);
    assert.deepEqual(notes.map((n) => n.id), ["1", "2"]);
  });

  test("the replied-to text is cut to REPLY_CONTEXT_CHARS; empty messages are dropped", () => {
    const long = "x".repeat(REPLY_CONTEXT_CHARS + 50);
    const notes = chatNotes([
      { id: "a", speaker: "A", text: long },
      { id: "b", speaker: "B", text: "   " },
      { id: "c", speaker: "B", text: "ok" },
    ]);
    assert.deepEqual(notes.map((n) => n.id), ["a", "c"]);
    const ctx = /\(replying to A: (x+)…\)$/.exec(notes[1].body);
    assert.ok(ctx, notes[1].body);
    assert.equal(ctx[1].length, REPLY_CONTEXT_CHARS);
  });

  test("a long first line is cut in the title, not in the body", () => {
    const text = "word ".repeat(100).trim();
    const [n] = chatNotes([{ id: "1", speaker: "User", text }]);
    assert.ok(n.title.length <= 120, String(n.title.length));
    assert.equal(n.body, text);
  });
});

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "monomem-chats-"));
  const proj = join(root, "C--work-shop");
  mkdirSync(proj);
  const at = (s: number): string => new Date(Date.UTC(2026, 10, 1, 10, 0, s)).toISOString();
  const lines = [
    { type: "session-owner", sessionId: "s1" },
    { type: "user", uuid: "u1", sessionId: "s1", timestamp: at(1), message: { role: "user", content: "<system-reminder>ignore me</system-reminder>Which port does staging use?" } },
    { type: "assistant", uuid: "a1", requestId: "r1", sessionId: "s1", timestamp: at(2), message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } },
    { type: "assistant", uuid: "a2", requestId: "r1", sessionId: "s1", timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "Let me check." }] } },
    { type: "assistant", uuid: "a3", requestId: "r1", sessionId: "s1", timestamp: at(4), message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } },
    { type: "user", uuid: "u2", sessionId: "s1", timestamp: at(5), message: { role: "user", content: [{ type: "tool_result", content: "PORT=9443" }] } },
    { type: "assistant", uuid: "a4", requestId: "r2", sessionId: "s1", timestamp: at(6), message: { role: "assistant", content: [{ type: "text", text: "Staging listens on 9443." }] } },
    { type: "user", uuid: "u3", isMeta: true, sessionId: "s1", timestamp: at(7), message: { role: "user", content: "meta line" } },
    { type: "user", uuid: "u4", isSidechain: true, sessionId: "s1", timestamp: at(8), message: { role: "user", content: "subagent prompt" } },
    { type: "user", uuid: "u5", sessionId: "s1", timestamp: at(9), message: { role: "user", content: "<command-name>/clear</command-name>" } },
  ];
  writeFileSync(join(proj, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n{broken json\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("readClaudeCodeChats", () => {
  test("keeps what people and Claude said; drops tool calls, tool results, thinking, meta, subagents and slash commands", () => {
    const { root, cleanup } = fixture();
    try {
      const items = readClaudeCodeChats(root);
      assert.deepEqual(items.map((i) => i.title), ["You: Which port does staging use?", "Claude: Let me check.", "Claude: Staging listens on 9443."]);
      assert.equal(items[0].body, "Which port does staging use?");
      assert.match(items[2].body, /\(replying to Claude: Let me check\.\)$/);
      assert.equal(items[0].group, "C--work-shop");
      assert.equal(items[0].createdAt, "2026-11-01T10:00:01.000Z");
      assert.ok(items.every((i) => i.tags.includes(CHAT_TAG)), "tagged with the import tag");
      assert.equal(CHAT_TAG, tagFor("claude-code-chats"));
      assert.ok(items[1].tags.includes("obs.writer:model") && !items[0].tags.includes("obs.writer:model"), "Claude's words are labelled model-written");
      assert.equal(new Set(items.map((i) => i.id)).size, 3, "stable unique ids");
    } finally {
      cleanup();
    }
  });

  test("import --from claude-code-chats writes into the chats namespace and a second run adds nothing", async () => {
    assert.ok((FOREIGN_SOURCES as readonly string[]).includes("claude-code-chats"));
    const { root, cleanup } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "monomem-chats-db-"));
    const dbPath = join(dir, "state.db");
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s), interactive: false, ask: async () => "" };
    const e = { home: dir, env: {}, cwd: dir };
    try {
      assert.equal(await runForeignImport(e, io as never, { from: "claude-code-chats", path: root, dryRun: true, yes: false, dbPath }), 0, out.join("\n"));
      assert.match(out.join("\n"), /Read 1 conversation file\(s\)\. 1 damaged line\(s\) skipped\./);
      assert.match(out.join("\n"), /3 item\(s\): 3 new/);
      assert.match(out.join("\n"), /Dry run: nothing was written/);
      out.length = 0;
      assert.equal(await runForeignImport(e, io as never, { from: "claude-code-chats", path: root, dryRun: false, yes: true, dbPath }), 0, out.join("\n"));
      const store = new Store(dbPath);
      try {
        const notes = store.search("staging", { namespace: "chats", limit: 5 });
        assert.ok(notes.some((n) => n.title === "Claude: Staging listens on 9443."), JSON.stringify(notes.map((n) => n.title)));
        assert.ok(notes.every((n) => n.namespace === "chats"));
      } finally {
        store.close();
      }
      // Searchable, but never pushed into a new session: thousands of old chat lines would crowd out real notes.
      const s2 = new Store(dbPath);
      try {
        s2.create({ title: "Real note about staging", body: "staging deploys go through the gate", tags: ["chat"] }); // a user's own "chat" tag stays visible
        const ctx = await injectContext(s2, { signals: { branch: "staging", diffFiles: [] } });
        assert.match(ctx, /Real note about staging/);
        assert.ok(!/Staging listens on 9443|Which port does staging use/.test(ctx), ctx);
        const ranked = await rankContext(s2, { signals: { branch: "staging", diffFiles: [] } });
        assert.ok(ranked.ranked.every((n) => !n.tags.includes(CHAT_TAG)), "no chat note in the session-start pool");
      } finally {
        s2.close();
      }
      out.length = 0;
      assert.equal(await runForeignImport(e, io as never, { from: "claude-code-chats", path: root, dryRun: false, yes: true, dbPath }), 0);
      assert.match(out.join("\n"), /0 new, 3 already imported/);
    } finally {
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("import --from claude-code-chats on an encrypted store", () => {
  test("titles are the fixed sealed title; the message words are nowhere in the database file; search still finds it", async () => {
    const { root, cleanup } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "monomem-chats-enc-"));
    ensureKey(dir);
    const dbPath = join(dir, "state.db");
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s), interactive: false, ask: async () => "" };
    try {
      assert.equal(await runForeignImport({ home: dir, env: {}, cwd: dir }, io as never, { from: "claude-code-chats", path: root, dryRun: false, yes: true, dbPath }), 0, out.join("\n"));
      const store = new Store(dbPath);
      try {
        const all = store.list({ namespace: "chats", limit: 10 }).notes;
        assert.equal(all.length, 3);
        assert.ok(all.every((n) => n.title === SEALED_CHAT_TITLE), JSON.stringify(all.map((n) => n.title)));
        assert.ok(all.some((n) => n.body.startsWith("Claude: Staging listens on 9443.\n")), "real title is the body's first line");
      } finally {
        store.close();
      }
      const bytes = readFileSync(dbPath).toString("latin1") + (existsSync(dbPath + "-wal") ? readFileSync(dbPath + "-wal").toString("latin1") : "");
      assert.ok(!bytes.includes("9443") && !bytes.includes("Staging listens"), "message text leaked into the database file");
    } finally {
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
