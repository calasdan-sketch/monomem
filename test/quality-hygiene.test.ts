// C20: quality and health grade the memory itself: empty notes, a fact restated by its own writer but never retired, and
// duplicates as one group per set of copies (4 copies = 1 group, not 6 pairs).
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { qualityReport } from "../src/quality.js";
import { runHealth } from "../src/health.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const day = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();

describe("quality: memory hygiene", () => {
  test("4 copies of one note are 1 duplicate group with 1 fix command that keeps the newest", async () => {
    const s = new Store(":memory:");
    const ids = [1, 2, 3, 4].map(() => s.create({ title: "Deploy on fridays", body: "we deploy every friday afternoon after the tests pass" }).id);
    for (const [i, id] of ids.entries()) s.captureDb().prepare("UPDATE notes SET updated_at = ? WHERE id = ?").run(day(10 - i), id);
    const r = await qualityReport(s);
    const dups = r.issues.filter((i) => i.type === "duplicate");
    assert.equal(dups.length, 1, JSON.stringify(dups));
    assert.equal(r.counts.duplicate, 1);
    assert.deepEqual(dups[0].ids.slice().sort((a, b) => a - b), ids);
    assert.equal(dups[0].fix, `monomem replace --old ${ids.slice(0, 3).join(",")} --new-id ${ids[3]}`);
    assert.equal(dups[0].ids[1], ids[3], "ids[0]/ids[1] stay an old copy and the one to keep (the dashboard's Replace button)");
    assert.match(dups[0].detail, /4 notes say the same thing/);
    s.close();
  });

  test("an empty note is listed with its fix", async () => {
    const s = new Store(":memory:");
    const e = s.create({ title: "build cmd", body: "" });
    s.create({ title: "fine", body: "has text" });
    const r = await qualityReport(s);
    const empty = r.issues.filter((i) => i.type === "empty");
    assert.deepEqual(empty.map((i) => i.ids), [[e.id]]);
    assert.equal(r.counts.empty, 1);
    assert.match(empty[0].fix, new RegExp(`^monomem edit ${e.id}`));
    s.close();
  });

  test("a fact restated by the same writer but not retired is listed; another writer's note is not", async () => {
    const s = new Store(":memory:");
    const old = as("good", () => s.create({ namespace: "work", title: "quarzo build server", body: "The quarzo build server is kalmuth.", tags: ["fact:build_server=kalmuth"] })).id;
    const neu = as("good", () => s.create({ namespace: "work", title: "quarzo build server moved", body: "Update: quarzo builds moved; the build server is now prendal.", tags: ["fact:build_server=prendal"] })).id;
    const other = as("someone-else", () => s.create({ namespace: "work", title: "quarzo build server", body: "the build server is zorba", tags: ["fact:build_server=zorba"] })).id;
    for (const [id, d] of [[old, 3], [neu, 2], [other, 1]]) s.captureDb().prepare("UPDATE notes SET created_at = ?, updated_at = ?, content_at = ? WHERE id = ?").run(day(d), day(d), day(d), id);
    const r = await qualityReport(s);
    const rs = r.issues.filter((i) => i.type === "restated");
    assert.deepEqual(rs.map((i) => i.ids), [[old, neu]], JSON.stringify(r.issues));
    assert.equal(rs[0].fix, `monomem replace --old ${old} --new-id ${neu}`);
    assert.equal(r.counts.restated, 1);
    s.close();
  });

  test("health has one memory line naming the empty, restated and duplicate counts (info: it does not cost a grade)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-hyg-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      s.create({ title: "build cmd", body: "" });
      s.create({ title: "Deploy on fridays", body: "we deploy every friday afternoon after the tests pass" });
      s.create({ title: "Deploy on fridays", body: "we deploy every friday afternoon after the tests pass" });
      s.close();
      const h = await runHealth({ dbPath: db, dataDir: dir, bindHost: "127.0.0.1", pluginsPath: join(dir, "no-plugins.json"), auditPath: join(dir, "audit.log"), settingsPath: join(dir, ".claude", "settings.json"), drill: async () => ({ ok: true, attacks: 1, reached: [], unexpected: [] }) as never });
      const line = h.checks.find((c) => c.id === "hygiene");
      assert.ok(line, JSON.stringify(h.checks.map((c) => c.id)));
      assert.equal(line.status, "info");
      assert.match(line.text, /1 empty note/);
      assert.match(line.text, /1 group of duplicates/);
      assert.match(line.text, /monomem review duplicates/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
