// Silent failures made visible (r3 silent-failures seat): a failing device sync, a backup rotation that cannot remove old
// copies, a late daily backup, a multi-action MCP tool called without `action`, and the hook / import / sync-marker paths
// that used to fail without a word.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { readSyncStatus, runConfiguredSync, setupSync, startSyncTimer, syncProblem } from "../src/sync/device.js";
import { needsYou, needsYouLine } from "../src/ui/needs-you.js";
import { runHealth } from "../src/health.js";
import { runDailyBackup, backupsDir, backupFailure } from "../src/backup-schedule.js";
import { readHandled } from "../src/sync/marks.js";
import { archiveLines } from "../src/sync-git.js";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "om-silent-"));
  const db = join(dir, "state.db");
  return { dir, db, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function io() {
  const lines: string[] = [];
  return { lines, interactive: false, out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l), ask: async () => "" };
}
const health = (dir: string, db: string, now?: Date) =>
  runHealth({ dbPath: db, dataDir: dir, bindHost: "127.0.0.1", settingsPath: join(dir, ".claude", "settings.json"), pluginsPath: join(dir, "none.json"), auditPath: join(dir, "audit.log"), drill: async () => ({ ok: true, attacks: 1, reached: [], unexpected: [] }) as never, ...(now ? { now } : {}) });

describe("device sync status is visible", () => {
  test("a failed sync is recorded with its reason and shows in check, Needs you and the session-start line", async () => {
    const w = scratch();
    try {
      const shared = join(w.dir, "OneDrive");
      assert.equal(await setupSync(io(), { dataDir: w.dir, dbPath: w.db, env: process.env, target: shared }), 0);
      assert.equal(readSyncStatus(w.dir)?.ok, true);
      assert.equal(syncProblem(w.dir), null);
      rmSync(shared, { recursive: true, force: true }); // the cloud folder is gone (drive not mounted)
      assert.equal(await runConfiguredSync(io(), { dataDir: w.dir, dbPath: w.db, env: process.env }), 1);
      const st = readSyncStatus(w.dir);
      assert.equal(st?.ok, false);
      assert.match(st!.error!, /is not there/);
      assert.equal(syncProblem(w.dir)?.kind, "failed");

      const h = await health(w.dir, w.db);
      const line = h.checks.find((c) => c.id === "sync");
      assert.equal(line?.status, "warn", JSON.stringify(h.checks.map((c) => c.id)));
      assert.match(line!.text, /failed: .*is not there/);

      const s = new Store(w.db);
      try {
        const n = needsYou(s, { dataDir: w.dir, conflicts: false });
        assert.ok(n.items.some((i) => i.kind === "sync"), JSON.stringify(n));
        assert.match(needsYouLine(s, { dataDir: w.dir }), /1 failed sync/);
      } finally {
        s.close();
      }
    } finally {
      w.done();
    }
  });

  test("automatic sync that has not run for 3 intervals warns in check; no sync set up says nothing", async () => {
    const w = scratch();
    try {
      assert.equal(syncProblem(w.dir), null);
      const shared = join(w.dir, "Dropbox");
      assert.equal(await setupSync(io(), { dataDir: w.dir, dbPath: w.dir + "/state.db", env: process.env, target: shared, auto: true, everyMinutes: 30 }), 0);
      const at = Date.parse(readSyncStatus(w.dir)!.at);
      assert.equal(syncProblem(w.dir, new Date(at + 60 * 60_000)), null, "1 hour: fine");
      const late = new Date(at + 2 * 60 * 60_000);
      assert.equal(syncProblem(w.dir, late)?.kind, "stale");
      const h = await health(w.dir, w.db, late);
      assert.match(h.checks.find((c) => c.id === "sync")?.text ?? "", /automatic sync is on/);
    } finally {
      w.done();
    }
  });

  test("the server timer logs a child's non-zero exit code", async () => {
    const w = scratch();
    try {
      assert.equal(await setupSync(io(), { dataDir: w.dir, dbPath: w.db, env: process.env, target: join(w.dir, "share"), auto: true }), 0);
      const logs: string[] = [];
      startSyncTimer(w.dir, () => ({ command: process.execPath, args: ["-e", "process.exit(3)"] }), (l) => void logs.push(l), 1);
      for (let i = 0; i < 200 && !logs.some((l) => /exit code 3/.test(l)); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(logs.some((l) => /device sync failed \(exit code 3\)/.test(l)), logs.join("\n"));
    } finally {
      w.done();
    }
  });
});

describe("backups that quietly stop", () => {
  test("rotation that cannot remove old copies records a failure (check and Needs you see it)", () => {
    const w = scratch();
    const s = new Store(w.db);
    try {
      s.create({ title: "a", body: "b" });
      const root = backupsDir(w.db);
      mkdirSync(root, { recursive: true });
      // 20 old days: rotation must remove some, and removing fails (a file held open on Windows, a read-only share).
      for (let d = 1; d <= 20; d++) mkdirSync(join(root, `2026-10-${String(d).padStart(2, "0")}`));
      const r = runDailyBackup(s, w.db, new Date("2026-11-16T09:00:00Z"), (p) => {
        throw new Error(`EPERM: operation not permitted, rmdir '${p}'`);
      });
      assert.equal(r.made, true);
      assert.match(r.error ?? "", /could not be removed/);
      assert.match(backupFailure(w.db)?.error ?? "", /could not be removed/);
    } finally {
      s.close();
      w.done();
    }
  });

  test("daily backups on but none for more than 2 days: check warns", async () => {
    const w = scratch();
    // The backup age also counts `monomem backup` folders in the home folder: point home at the scratch dir so real
    // backups on this computer cannot make the scratch store look freshly backed up.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = w.dir;
    try {
      new Store(w.db).close();
      writeFileSync(join(w.dir, ".last-backup"), "2026-11-10T09:00:00.000Z\n");
      const h = await health(w.dir, w.db, new Date("2026-11-16T09:00:00Z"));
      const line = h.checks.find((c) => c.id === "backup");
      assert.equal(line?.status, "warn", JSON.stringify(line));
      assert.match(line!.text, /6 days old/);
      const fresh = await health(w.dir, w.db, new Date("2026-11-11T09:00:00Z"));
      assert.equal(fresh.checks.find((c) => c.id === "backup")?.status, "info");
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      w.done();
    }
  });
});

describe("multi-action MCP tools without `action`", () => {
  async function client(store: Store) {
    const server = createMcpServer(store, "admin", {}, {});
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([c.connect(ct), server.connect(st)]);
    return c;
  }
  const text = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0].text;

  test("arguments the first action does not use: a clear error, nothing done", async () => {
    const prior = process.env.MONOMEM_TOOLS;
    process.env.MONOMEM_TOOLS = "all";
    const store = new Store(":memory:");
    try {
      const c = await client(store);
      const t = await c.callTool({ name: "memory_trust", arguments: { writer: "bot" } });
      assert.equal(t.isError, true, text(t));
      assert.match(text(t), /memory_trust needs an action \(one of: list, distrust/);
      const r = await c.callTool({ name: "memory_review", arguments: { id: 1, reason: "looks wrong" } });
      assert.equal(r.isError, true, text(r));
      assert.match(text(r), /needs an action|action/);
      // The plain default still works: no extra arguments.
      const h = await c.callTool({ name: "memory_held", arguments: {} });
      assert.notEqual(h.isError, true, text(h));
      const n = store.create({ title: "x", body: "y" });
      const hist = await c.callTool({ name: "memory_history", arguments: { id: n.id } });
      assert.notEqual(hist.isError, true, text(hist));
    } finally {
      if (prior === undefined) delete process.env.MONOMEM_TOOLS;
      else process.env.MONOMEM_TOOLS = prior;
      store.close();
    }
  });
});

describe("quiet paths now say one line", () => {
  test("readHandled on damaged JSON logs to stderr and starts again", () => {
    const store = new Store(":memory:");
    const write = process.stderr.write.bind(process.stderr);
    let said = "";
    process.stderr.write = ((s: string | Uint8Array) => ((said += String(s)), true)) as typeof process.stderr.write;
    try {
      store.setMeta("sync_marks", "{damaged");
      assert.equal(readHandled(store).size, 0);
    } finally {
      process.stderr.write = write;
      store.close();
    }
    assert.match(said, /archive markers is damaged/);
  });

  test("import --dir prints what tombstones did (archiveLines)", () => {
    assert.deepEqual(archiveLines({ archived: 0, kept: 0, restored: 0, lines: [] }), []);
    const l = archiveLines({ archived: 2, kept: 1, restored: 1, lines: ["#4 Port (edited here)"] });
    assert.match(l.join("\n"), /archived 2 notes that another computer archived/);
    assert.match(l.join("\n"), /brought back 1 archived note /);
    assert.match(l.join("\n"), /kept 1 note live here[\s\S]*#4 Port/);
  });

  test("hook session-start outer catch writes one stderr line", () => {
    const src = readFileSync(new URL("../../src/hook.ts", import.meta.url), "utf8");
    assert.match(src, /catch \(e\) \{\s*process\.stderr\.write\(`monomem hook session-start: no notes this time/);
  });
});
