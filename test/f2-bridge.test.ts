// F2 lane "bridge": the Claude Code memory bridge (PLAN C16) and bringing in other agents' memories (PLAN I).
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { runClaudeImport, type ClaudeImportOptions } from "../src/claude-import.js";
import { STATE_FILE, bridgeLine, bridgeOn, bridgeStatus, bridgeTick, heldImports, offerClaudeMemoryImport, readBridgeState } from "../src/claude-refresh.js";
import { runForeignImport, FOREIGN_SOURCES } from "../src/foreign-import.js";
import { readCodexMemories } from "../src/importers/codex.js";
import { readNotion } from "../src/importers/notion.js";
import { readZipMarkdown } from "../src/importers/zip.js";
import { importArgs } from "../src/importers/sources.js";
import { updateUiSettings } from "../src/ui/settings.js";
import type { SetupIO } from "../src/setup.js";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { setUiRunner } from "../src/api/routes-ui.js";
import { mintLoginCode } from "../src/login-code.js";
import { SETTINGS_JS } from "../src/ui/js-settings.js";

const roots: string[] = [];
afterEach(() => {
  setUiRunner(null);
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "om-f2b-"));
  roots.push(root);
  const home = join(root, "home");
  const w = (p: string, s: string): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, s);
  };
  const mem = join(home, ".claude", "projects", "-home-avery-atlas", "memory");
  w(join(home, ".claude", "CLAUDE.md"), "# Prefs\n\n## Style\nNo emojis.\n");
  w(join(mem, "MEMORY.md"), "- [Role](user_role.md)\n");
  w(join(mem, "user_role.md"), "---\nname: Avery's role\ntype: user\n---\nAvery is a founder.\n");
  w(join(mem, "build.md"), "---\nname: Build\n---\nUse pnpm.\n");
  const proj = join(root, "proj");
  mkdirSync(proj, { recursive: true });
  return { root, home, mem, proj, w, e: { home, env: { HOME: home } as NodeJS.ProcessEnv, cwd: proj }, db: join(root, "data", "state.db") };
}
function io(): SetupIO & { all: () => string } {
  const lines: string[] = [];
  return { interactive: false, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => "", all: () => lines.join("\n") };
}
const o = (db: string, x: Partial<ClaudeImportOptions> = {}): ClaudeImportOptions => ({ dryRun: false, yes: true, update: false, projects: [], includeIndex: false, dbPath: db, ...x });
const withStore = <T>(db: string, f: (s: Store) => T): T => {
  const s = new Store(db);
  try {
    return f(s);
  } finally {
    s.close();
  }
};
const notes = (db: string) => withStore(db, (s) => s.list({ limit: 500, includeArchived: true }).notes);

describe("C16: import --claude remembers what it imported", () => {
  test("a run records each file; the next run reads only what changed and still reports the rest as already there", async () => {
    const f = fixture();
    await runClaudeImport(f.e, io(), o(f.db));
    const st = readBridgeState(f.db);
    assert.ok(st.last_import, "last import time recorded");
    assert.equal(Object.keys(st.files).length, 3, "user CLAUDE.md and two topic files");
    assert.ok(Object.values(st.files).every((x) => x.locs.length > 0 && /^[0-9a-f]{16}$/.test(x.hash)));
    assert.deepEqual(await bridgeStatus(f.e, f.db).then((s) => [s.files, s.changed, s.gone]), [3, 0, 0]);
    f.w(join(f.mem, "build.md"), "---\nname: Build\n---\nUse pnpm, never npm.\n");
    assert.equal((await bridgeStatus(f.e, f.db)).changed, 1);
    const x = io();
    await runClaudeImport(f.e, x, o(f.db, { update: true }));
    assert.match(x.all(), /0 new, 2 already imported, 1 changed since/);
    assert.ok(notes(f.db).some((n) => n.body.includes("never npm")));
  });

  test("a changed file left alone (no --update) is not recorded, so a later --update still refreshes it", async () => {
    const f = fixture();
    await runClaudeImport(f.e, io(), o(f.db));
    f.w(join(f.mem, "build.md"), "---\nname: Build\n---\nUse bun.\n");
    await runClaudeImport(f.e, io(), o(f.db));
    await runClaudeImport(f.e, io(), o(f.db, { update: true }));
    assert.ok(notes(f.db).some((n) => n.body.includes("Use bun")));
  });

  test("a note deleted in Monomem comes back on the next run (its file is read again)", async () => {
    const f = fixture();
    await runClaudeImport(f.e, io(), o(f.db));
    const id = notes(f.db).find((n) => n.body.includes("Use pnpm"))!.id;
    withStore(f.db, (s) => s.delete(id));
    await runClaudeImport(f.e, io(), o(f.db));
    assert.ok(notes(f.db).some((n) => n.body.includes("Use pnpm")));
  });

  test("a file Claude Code removed is reported once, with the notes Monomem still has", async () => {
    const f = fixture();
    await runClaudeImport(f.e, io(), o(f.db));
    const id = notes(f.db).find((n) => n.body.includes("Use pnpm"))!.id;
    unlinkSync(join(f.mem, "build.md"));
    assert.equal((await bridgeStatus(f.e, f.db)).gone, 1);
    const x = io();
    await runClaudeImport(f.e, x, o(f.db));
    assert.match(x.all(), new RegExp(`build\\.md is gone since the last import.*#${id}`));
    assert.ok(notes(f.db).some((n) => n.id === id), "the note stays");
    const y = io();
    await runClaudeImport(f.e, y, o(f.db));
    assert.doesNotMatch(y.all(), /is gone/);
  });

  test("a dry run writes no state", async () => {
    const f = fixture();
    await runClaudeImport(f.e, io(), o(f.db, { dryRun: true }));
    assert.equal(existsSync(join(dirname(f.db), STATE_FILE)), false);
  });

  test("--no-project leaves out the current folder's CLAUDE.md", async () => {
    const f = fixture();
    f.w(join(f.proj, "CLAUDE.md"), "## Build\nmake\n");
    assert.equal((await bridgeStatus(f.e, f.db)).files, 4);
    assert.equal((await bridgeStatus(f.e, f.db, true)).files, 3);
  });
});

describe("C16: the check line, the switch and the server refresh", () => {
  test("check line: an offer before any import; after one, changes and held count, never 'Auto Dream'", async () => {
    const f = fixture();
    assert.match((await bridgeLine(f.e, f.db, 0))!, /keeps its own memory here \(3 file\(s\)\).*monomem import --claude/);
    await runClaudeImport(f.e, io(), o(f.db));
    const held = withStore(f.db, (s) => heldImports(s));
    assert.equal(held, 3, "every imported section is held until a person confirms it");
    const line = (await bridgeLine(f.e, f.db, held))!;
    assert.match(line, /last import .*; 0 file\(s\) new or changed since; 3 imported note\(s\) unconfirmed \(from outside\) until you confirm them \(monomem review; monomem confirm <id>\)/);
    assert.doesNotMatch(line, /auto dream/i);
    const empty = mkdtempSync(join(tmpdir(), "om-f2b-empty-"));
    roots.push(empty);
    assert.equal(await bridgeLine({ home: empty, env: {}, cwd: empty }, join(empty, "x.db"), 0), null);
  });

  test("the refresh is off by default; the Settings switch or MONOMEM_CLAUDE_REFRESH turns it on (the variable wins)", () => {
    const d = mkdtempSync(join(tmpdir(), "om-f2b-sw-"));
    roots.push(d);
    assert.equal(bridgeOn({}, d), false);
    updateUiSettings({ claude_refresh: "on" }, d);
    assert.equal(bridgeOn({}, d), true);
    assert.equal(bridgeOn({ MONOMEM_CLAUDE_REFRESH: "off" }, d), false);
    assert.equal(bridgeOn({ MONOMEM_CLAUDE_REFRESH: "on" }, mkdtempSync(join(tmpdir(), "om-f2b-sw2-"))), true);
  });

  test("a tick does nothing while off, and brings changed files in held when on", async () => {
    const f = fixture();
    const logs: string[] = [];
    await bridgeTick(f.e, f.db, dirname(f.db), (l) => void logs.push(l));
    assert.equal(existsSync(f.db), false, "off: nothing opened or written");
    const on = { ...f.e, env: { ...f.e.env, MONOMEM_CLAUDE_REFRESH: "on" } };
    await bridgeTick(on, f.db, dirname(f.db), (l) => void logs.push(l));
    assert.equal(notes(f.db).length, 3);
    assert.equal(withStore(f.db, (s) => heldImports(s)), 3);
    assert.match(logs.join("\n"), /Imported 3 new note/);
    logs.length = 0;
    await bridgeTick(on, f.db, dirname(f.db), (l) => void logs.push(l));
    assert.equal(logs.length, 0, "nothing changed: quiet, no store opened for nothing");
  });
});

// ---- other agents' memories ---------------------------------------------------------------------------------------------

/** A minimal zip writer for the tests: deflated entries. */
function zip(entries: Array<[string, Buffer | string]>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const [name, raw] of entries) {
    const data = Buffer.from(raw);
    const comp = deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp);
    central.push(ch, n);
    off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("I: Codex memories", () => {
  test("reads MEMORY.md and memory_summary.md in memories/ and memories_v2/, one note per section, the same section once", () => {
    const f = fixture();
    const codex = join(f.home, ".codex");
    const handbook = "# Task Group: atlas deploys\n\n## Task 1: deploy to fly\nfly deploy from main.\n\n## User preferences\nShort answers.\n";
    f.w(join(codex, "memories", "MEMORY.md"), handbook);
    f.w(join(codex, "memories_v2", "MEMORY.md"), handbook);
    f.w(join(codex, "memories", "memory_summary.md"), "v1\n## User Profile\nA founder.\n");
    f.w(join(codex, "memories", "raw_memories.md"), "## raw\nnot read\n");
    const items = readCodexMemories(codex, 1 << 20);
    assert.deepEqual(items.map((i) => i.title).sort(), ["Task Group: atlas deploys / Task 1: deploy to fly", "Task Group: atlas deploys / User preferences", "User Profile"]);
    assert.ok(!items.some((i) => /not read|^v1/.test(i.body)));
  });

  test("no memory files: a plain message that the feature must be switched on in Codex", () => {
    const f = fixture();
    mkdirSync(join(f.home, ".codex"), { recursive: true });
    assert.throws(() => readCodexMemories(join(f.home, ".codex"), 1 << 20), /memories feature is switched on/);
  });

  test("import --from codex finds ~/.codex (or CODEX_HOME), labels and holds every note", async () => {
    const f = fixture();
    f.w(join(f.root, "ch", "memories", "MEMORY.md"), "## User preferences\nShort answers.\n");
    const e = { ...f.e, env: { ...f.e.env, CODEX_HOME: join(f.root, "ch") } };
    assert.equal(await runForeignImport(e, io(), { from: "codex", dryRun: false, yes: true, dbPath: f.db }), 0);
    const n = notes(f.db);
    assert.equal(n.length, 1);
    assert.equal(n[0].written_by, "import:codex");
    assert.ok(n[0].tags.includes("imported:codex"));
    assert.equal(withStore(f.db, (s) => s.unconfirmedRows().length), 1, "held until a person confirms it");
  });
});

describe("I: Notion exports", () => {
  const page = "# Launch plan\n\nShip on Monday.\n";
  test("a folder: one note per page, the Notion id dropped from title and path", () => {
    const f = fixture();
    f.w(join(f.root, "n", "Team 0123456789abcdef0123456789abcdef", "Launch plan 89abcdef0123456789abcdef01234567.md"), page);
    f.w(join(f.root, "n", "Team 0123456789abcdef0123456789abcdef.md"), "# Team\n\n");
    f.w(join(f.root, "n", "db.csv"), "a,b\n");
    const items = readNotion(join(f.root, "n"), 1 << 20);
    assert.equal(items.length, 1, "empty pages and .csv tables are not notes");
    assert.equal(items[0].title, "Launch plan");
    assert.equal(items[0].group, "Team");
    assert.equal(items[0].body, "Ship on Monday.");
  });

  test("a zip, with a part zip inside (big exports), read in memory; too-big pages are counted, not read", () => {
    const inner = zip([["Team/Notes 0123456789abcdef0123456789abcdef.md", "# Notes\n\nInner page.\n"]]);
    const buf = zip([["Launch plan 89abcdef0123456789abcdef01234567.md", page], ["Export-Part-1.zip", inner], ["huge.md", "# H\n\n" + "x".repeat(2000)]]);
    const stats = { skipped: 0 };
    const got = readZipMarkdown(buf, 1000, stats);
    assert.deepEqual(got.map((g) => g.name).sort(), ["Launch plan 89abcdef0123456789abcdef01234567.md", "Team/Notes 0123456789abcdef0123456789abcdef.md"]);
    assert.equal(stats.skipped, 1);
    assert.throws(() => readZipMarkdown(Buffer.from("not a zip at all, just text"), 1000), /not a zip/);
  });

  test("import --from notion needs --path, then imports a zip held and labelled", async () => {
    const f = fixture();
    const x = io();
    assert.equal(await runForeignImport(f.e, x, { from: "notion", dryRun: false, yes: true, dbPath: f.db }), 1);
    assert.match(x.all(), /--from notion --path/);
    writeFileSync(join(f.root, "export.zip"), zip([["Launch plan 89abcdef0123456789abcdef01234567.md", page]]));
    const y = io();
    assert.equal(await runForeignImport(f.e, y, { from: "notion", path: join(f.root, "export.zip"), dryRun: false, yes: true, dbPath: f.db }), 0);
    assert.match(y.all(), /unconfirmed \(from outside\) until you confirm them/);
    const n = notes(f.db);
    assert.deepEqual([n.length, n[0].title, n[0].written_by], [1, "Launch plan", "import:notion"]);
    assert.equal(withStore(f.db, (s) => s.unconfirmedRows().length), 1);
    await runForeignImport(f.e, io(), { from: "notion", path: join(f.root, "export.zip"), dryRun: false, yes: true, dbPath: f.db });
    assert.equal(notes(f.db).length, 1, "a second run adds nothing");
  });

  test("the existing importers now hold their notes too (mem0 as the example)", async () => {
    const f = fixture();
    const p = join(f.root, "mem0.json");
    writeFileSync(p, JSON.stringify([{ id: "m1", memory: "Prefers dark mode", user_id: "avery" }]));
    await runForeignImport(f.e, io(), { from: "mem0", path: p, dryRun: false, yes: true, dbPath: f.db });
    assert.equal(withStore(f.db, (s) => s.unconfirmedRows().length), 1);
    assert.ok(FOREIGN_SOURCES.includes("codex") && FOREIGN_SOURCES.includes("notion"));
  });
});

describe("I: the dashboard's Bring in memories", () => {
  test("GET/POST /ui/import need the local sign-in; POST runs only the import it names", async () => {
    const runs: string[][] = [];
    setUiRunner(async (args) => (runs.push(args), { code: 0, output: "Imported 2 new note(s)." }));
    const s = new Store(":memory:");
    const ADMIN = "a".repeat(40);
    const server = createApiServer(s, [{ token: ADMIN, scope: "admin", label: "primary" }]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const call = (m: string, body?: unknown, h: Record<string, string> = {}) =>
        fetch(base + "/ui/import", { method: m, headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json", ...h }, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal((await call("GET")).status, 403);
      assert.equal((await call("POST", { id: "claude" })).status, 403);
      const login = (await (await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: mintLoginCode(Date.now(), false) }) })).json()) as { local_session: string };
      const h = { "X-Monomem-Local": login.local_session };
      assert.equal((await call("POST", { id: "claude --purge" }, h)).status, 400);
      assert.equal((await call("POST", { id: "notion" }, h)).status, 400, "a path-only source is not run from the page");
      const r = (await (await call("POST", { id: "codex" }, h)).json()) as { ok: boolean };
      assert.equal(r.ok, true);
      await call("POST", { id: "claude" }, h);
      assert.deepEqual(runs, [importArgs("codex"), importArgs("claude")]);
      assert.deepEqual(importArgs("claude"), ["import", "--claude", "--no-project", "--yes"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });

  test("the Welcome step offers Bring in memories and asks before each import", () => {
    const js = SETTINGS_JS;
    assert.match(js, /Bring in memories/);
    assert.match(js, /ask\("Copy/);
    assert.match(js, /unconfirmed \(from outside\) until you confirm/);
    assert.doesNotMatch(js, /held until you confirm/);
  });
});

describe("C16: setup's offer", () => {
  const ask = (answers: string[]): SetupIO & { all: () => string; asked: number } => {
    const lines: string[] = [];
    const o = { interactive: true, asked: 0, out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l), ask: async () => (o.asked++, answers.shift() ?? ""), all: () => lines.join("\n") };
    return o;
  };
  const env = (f: ReturnType<typeof fixture>) => ({ ...f.e, platform: process.platform } as unknown as import("../src/setup.js").SetupEnv);

  test("without a terminal (or with --yes) it only prints the command; nothing is written", async () => {
    const f = fixture();
    const x = io();
    await offerClaudeMemoryImport(env(f), x, false, f.db);
    assert.match(x.all(), /keeps its own memory.*monomem import --claude/s);
    assert.equal(existsSync(f.db), false);
  });

  test("asks first: Enter skips; y imports held, and a second y switches the refresh on", async () => {
    const f = fixture();
    const skip = ask([""]);
    await offerClaudeMemoryImport(env(f), skip, false, f.db);
    assert.equal(existsSync(f.db), false, "no answer, no import");
    const yes = ask(["y", "y"]);
    await offerClaudeMemoryImport(env(f), yes, false, f.db);
    assert.match(yes.all(), /first 200 lines\s+\(25 KB\) of MEMORY\.md/);
    assert.equal(withStore(f.db, (s) => heldImports(s)), 3);
    assert.equal(bridgeOn({}, dirname(f.db)), true);
    const again = ask([]);
    await offerClaudeMemoryImport(env(f), again, false, f.db);
    assert.equal(again.asked, 0, "not offered again after an import");
  });
});
