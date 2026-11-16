// v16: captured observations and summaries do not feed the note housekeeping: memory_stats totals, the stale count and
// every duplicate/consolidation path leave them out.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store, ValidationError } from "../src/store.js";
import { findCandidates, findCandidatesCooperative, resolveConsolidationNotes } from "../src/consolidate.js";

const longAgo = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();

describe("captured rows and note housekeeping", () => {
  test("accessStats and staleCount count ordinary notes only", () => {
    const s = new Store(":memory:");
    s.create({ title: "Old plain note", body: "a", created_at: longAgo }, { updatedAt: longAgo });
    for (let i = 0; i < 3; i++) s.create({ title: `Old observation ${i}`, body: "b", created_at: longAgo }, { updatedAt: longAgo, kind: "observation", sessionId: "s", obsType: "change" });
    s.create({ title: "Old summary", body: "c", created_at: longAgo }, { updatedAt: longAgo, kind: "summary", sessionId: "s" });
    const st = s.accessStats();
    assert.equal(st.totalNotes, 1);
    assert.equal(st.neverAccessed, 1);
    assert.deepEqual(st.mostAccessed.map((n) => n.title), [], "never read, so not listed as most accessed");
    assert.equal(st.staleCount, 1);
    assert.equal(s.staleCount(["default"]), 1);
    s.close();
  });

  test("duplicate scans skip captured rows; consolidating one by id is refused", async () => {
    const s = new Store(":memory:");
    const n1 = s.create({ title: "Deploy on fridays", body: "we deploy every friday afternoon" });
    const n2 = s.create({ title: "Deploy on fridays", body: "we deploy every friday afternoon" });
    const o1 = s.create({ title: "Edited src/a.ts", body: "changed src/a.ts" }, { kind: "observation", sessionId: "s1", obsType: "change" });
    const o2 = s.create({ title: "Edited src/a.ts", body: "changed src/a.ts" }, { kind: "observation", sessionId: "s2", obsType: "change" });
    const pool = s.exportAll({ live: true });
    const ids = (pairs: Array<{ idA: number; idB: number }>) => pairs.map((p) => [p.idA, p.idB].sort((x, y) => x - y));
    assert.deepEqual(ids(findCandidates(pool)), [[n1.id, n2.id]]);
    assert.deepEqual(ids(await findCandidatesCooperative(pool)), [[n1.id, n2.id]]);
    assert.throws(() => resolveConsolidationNotes(s, [o1.id, o2.id]), (e: unknown) => e instanceof ValidationError && /captured observation/.test((e as Error).message));
    assert.equal(resolveConsolidationNotes(s, [n1.id, n2.id]).length, 2);
    s.close();
  });
});

// 1.5.0 R1-13: the spool drain is exactly-once and never drops the late taint mark silently.
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeHookInput, spoolEvent, drainSpool, SPOOL_FILE, SPOOL_MAX_TRIES } from "../src/capture.js";
import { actorStore, setProcessWriter } from "../src/actor.js";

describe("R1-13 spool drain", () => {
  const webEvent = () => normalizeHookInput("post-tool", { session_id: "late", cwd: "/w", tool_name: "WebFetch", tool_input: { url: "https://x.example" }, tool_response: "page" }, new Date(Date.now() - 60_000));
  const rows = (s: Store): number => Number((s.captureDb().prepare("SELECT COUNT(*) AS n FROM capture_events").get() as { n: number }).n);
  const events = (s: Store): number => Number((s.captureDb().prepare("SELECT event_count AS n FROM sessions WHERE id = 'late'").get() as { n: number }).n);

  test("retroTaint failing once: one capture_events row, the counter moves once, the note is stamped by the next drain", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-r113-"));
    let s: Store | undefined;
    try {
      s = new Store(join(dir, "state.db"));
      setProcessWriter("stdio:cursor");
      const note = actorStore.run({ label: "stdio:cursor", cwd: "/w" }, () => s!.create({ title: "written after the web read", body: "b" }));
      setProcessWriter("");
      spoolEvent(dir, { ...webEvent(), namespace: "default" }, null);
      const real = s.retroTaint.bind(s);
      let calls = 0;
      s.retroTaint = ((...a: Parameters<Store["retroTaint"]>) => {
        calls++;
        // fails for every in-place retry of the first drain, succeeds afterwards
        if (calls <= 3) throw new Error("db busy");
        return real(...a);
      }) as Store["retroTaint"];
      assert.equal(drainSpool(s, dir), 1, "the event itself was stored");
      assert.equal(rows(s), 1);
      assert.equal(events(s), 1);
      assert.equal(s.read(note.id)!.unconfirmed, undefined, "not stamped yet");
      const left = readFileSync(join(dir, SPOOL_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(left.length, 1, "a retro-only line is waiting");
      assert.equal(left[0].retro_only, true);
      drainSpool(s, dir);
      assert.equal(rows(s), 1, "never stored twice");
      assert.equal(events(s), 1, "counter moved once");
      assert.ok(s.read(note.id)!.tags.some((t) => t.startsWith("obs.origin:tool:")), "stamped on the next drain");
      assert.ok(!existsSync(join(dir, SPOOL_FILE)));
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same spooled line drained twice (a crash after the insert) is stored once", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-r113-"));
    let s: Store | undefined;
    try {
      s = new Store(join(dir, "state.db"));
      spoolEvent(dir, { ...webEvent(), namespace: "default" }, null);
      const line = readFileSync(join(dir, SPOOL_FILE), "utf8");
      drainSpool(s, dir);
      writeFileSync(join(dir, SPOOL_FILE), line); // the same line comes back
      drainSpool(s, dir);
      assert.equal(rows(s), 1);
      assert.equal(events(s), 1);
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tries exhausted: the drop is counted and written to the audit log (count only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-r113-"));
    let s: Store | undefined;
    try {
      s = new Store(join(dir, "state.db"));
      writeFileSync(join(dir, SPOOL_FILE), JSON.stringify({ ...webEvent(), namespace: "default", tries: SPOOL_MAX_TRIES - 1 }) + "\n");
      s.captureDb().exec("DROP TABLE capture_events"); // every insert now fails
      drainSpool(s, dir);
      assert.ok(!existsSync(join(dir, SPOOL_FILE)), "dropped");
      const audit = readFileSync(join(process.env.MONOMEM_HOME!, "audit.log"), "utf8");
      assert.match(audit, /"op":"spool-drop"/);
      assert.ok(!audit.includes("x.example"), "no event content in the audit row");
    } finally {
      s?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
