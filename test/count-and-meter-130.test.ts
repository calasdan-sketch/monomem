// 1.3.0: `monomem doctor` and `monomem health` report the same note count (every namespace, every kind),
// and the meter's "saved" figure does not re-count the whole capture log on every session start.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { runHealth } from "../src/health.js";
import { injectContext } from "../src/context-inject.js";
import { meterStats } from "../src/meter.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

describe("doctor and health agree on the note count", () => {
  test("notes, observations and summaries in two namespaces: both commands count all of them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-count-"));
    try {
      const dbPath = join(dir, "state.db");
      const s = new Store(dbPath);
      for (let i = 0; i < 2; i++) s.create({ title: `default ${i}`, body: "x" });
      for (let i = 0; i < 3; i++) s.create({ title: `work ${i}`, body: "x", namespace: "work" });
      // Captured work: an observation and a session summary. list() leaves these out; health counts them.
      s.create({ title: "Edited the store", body: "x", namespace: "work" }, { kind: "observation", sessionId: "s1", obsType: "change" });
      s.create({ title: "Session: refactor", body: "Request: refactor" }, { kind: "summary", sessionId: "s1" });
      s.close();

      const r = spawnSync(process.execPath, ["--no-warnings", CLI, "doctor"], { env: { ...process.env, MONOMEM_HOME: dir, HOME: dir }, encoding: "utf8" });
      const doctorCount = Number(/database OK at .*\((\d+) notes\)/.exec(r.stdout + r.stderr)?.[1]);

      const h = await runHealth({ dbPath, dataDir: dir, bindHost: "127.0.0.1", settingsPath: join(dir, "settings.json"), pluginsPath: join(dir, "p.json"), auditPath: join(dir, "audit.log"), drill: async () => ({ notes: 0, attacks: 1, rows: [], reached: [], unexpected: [], ok: true, elapsed_ms: 1, approve_first: false }) });
      const healthCount = Number(/^(\d+) notes?,/.exec(h.checks.find((c) => c.id === "memory")!.text)?.[1]);

      assert.equal(healthCount, 7);
      assert.equal(doctorCount, 7, r.stdout + r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("meter: saved tokens are not double counted", () => {
  test("a big capture log adds nothing to 'saved', and every session counts only its own notes", async () => {
    const s = new Store(":memory:");
    s.create({ title: "Decision: use node:sqlite", body: "decided ".repeat(50) });
    const db = s.captureDb();
    db.prepare("INSERT INTO sessions (id, namespace, started_at) VALUES ('old', '', '2026-10-31')").run();
    // ~1 MB of captured work from an earlier session: the old code added all of it to "saved" on every injection.
    db.prepare("INSERT INTO capture_events (session_id, at, event, output, bytes) VALUES ('old', '2026-10-31', 'post-tool', '', 1000000)").run();
    const noGit = { branch: "", diffFiles: [] };
    await injectContext(s, { signals: noGit, sessionId: "s1" });
    await injectContext(s, { signals: noGit, sessionId: "s2" });
    const rows = meterStats(s).recent;
    const saved = rows.map((r) => r.saved_tokens);
    assert.equal(rows.length, 2);
    assert.equal(saved[0], saved[1], "same notes shown, same saving: no growth per session");
    assert.ok(saved[0] < 1000, `saved ${saved[0]} must not include the 250,000-token capture log`);
    s.close();
  });
});
