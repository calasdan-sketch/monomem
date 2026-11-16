// Schema v21 (1.5.0): one migration for every 1.5.0 column. A v20 store upgrades without hiding any previously visible note.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { rankContext } from "../src/context-inject.js";
import { setProcessWriter } from "../src/actor.js";
import { downgradeTo } from "./legacy-db.js";

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const cols = (db: DatabaseSync, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
afterEach(() => setProcessWriter(""));

function quietOpen(path: string): Store {
  const quiet = console.error;
  console.error = () => undefined;
  try {
    return new Store(path);
  } finally {
    console.error = quiet;
  }
}

describe("schema v21", () => {
  test("a fresh store has the v21 columns", () => {
    assert.equal(SCHEMA_VERSION, 22);
    const s = new Store(":memory:");
    const c = cols(s.captureDb() as unknown as DatabaseSync, "notes");
    assert.ok(c.includes("content_at") && c.includes("writer_cwd"));
    s.close();
  });

  test("v20 -> v21: no previously visible note is hidden, expiry labels and review list are unchanged, one backup at v20", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-v21-"));
    try {
      const path = join(dir, "state.db");
      const s0 = new Store(path);
      setProcessWriter("stdio:bot");
      const stale = s0.create({ namespace: "work", title: "stale deploy guide", body: "deploy steps" });
      const corro = s0.create({ namespace: "work", title: "corroborated deploy guide", body: "deploy steps two" });
      const fresh = s0.create({ namespace: "work", title: "fresh deploy guide", body: "deploy steps three" });
      const web = s0.create({ namespace: "work", title: "web deploy page", body: "deploy from web", outside: true });
      const db = s0.captureDb();
      for (const n of [stale, corro]) db.prepare("UPDATE notes SET updated_at = ?, created_at = ?, grandfathered_at = NULL WHERE id = ?").run(ago(40), ago(40), n.id);
      // A v20 corroborated confirm restarted the clock: it was confirmed 3 days ago.
      db.prepare("UPDATE notes SET confirmed_at = ?, confirmed_kind = 'corroborated', confirmed_rev = rev, confirmed_by = 'tokB' WHERE id = ?").run(ago(3), corro.id);
      const expiredNow = (s: Store) => s.list({ namespace: "work", limit: 100 }).notes.filter((n) => n.expired).map((n) => n.id).sort();
      s0.close();
      downgradeTo(path, 20);
      assert.equal(Store.peekSchemaVersion(path), 20);
      const s = quietOpen(path);
      try {
        assert.equal(Store.peekSchemaVersion(path), 22);
        assert.equal(Store.peekSchemaVersion(path + ".pre-v22-backup"), 20);
        const all = s.list({ namespace: "work", limit: 100 }).notes.map((n) => n.id).sort();
        assert.deepEqual(all, [stale.id, corro.id, fresh.id, web.id].sort(), "every note still listed");
        assert.deepEqual(expiredNow(s), [stale.id], "same expiry labels as under v20 (the corroborated note was not due)");
        assert.equal(s.read(corro.id)!.expired, undefined);
        const ctx = await rankContext(s, { namespace: "work" });
        assert.ok([stale.id, corro.id, fresh.id].every((id) => ctx.ranked.some((n) => n.id === id)), "session-start pool unchanged");
        assert.deepEqual(s.reviewList().map((r) => r.id).sort(), [stale.id, web.id].sort());
      } finally {
        s.close();
      }
      // Idempotent: reopening changes nothing.
      const again = quietOpen(path);
      assert.equal(again.read(corro.id)!.expired, undefined);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
