// Schema v20 (1.4.0): trust columns and tables in one migration. Upgrading a populated v19 store hides nothing: list, search
// and the session-start pool are identical before and after, and every existing note is stamped grandfathered_at.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { rankContext } from "../src/context-inject.js";
import { downgradeTo } from "./legacy-db.js";

const cols = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

async function snapshot(s: Store) {
  const ctx = await rankContext(s, { namespace: "work" });
  return {
    list: s.list({ namespace: "work", limit: 500 }).notes.map((n) => [n.id, n.title, n.updated_at]),
    search: s.search("deploy", { namespace: "work" }).map((n) => n.id),
    ranked: ctx.ranked.map((n) => n.id),
    pinned: ctx.pinned.map((n) => n.id),
    summary: ctx.latestSummary?.id ?? null,
    total: ctx.total,
  };
}

function quietOpen(path: string): Store {
  const quiet = console.error;
  console.error = () => undefined;
  try {
    return new Store(path);
  } finally {
    console.error = quiet;
  }
}

describe("schema v20", () => {
  test("a fresh store has every v20 column and table", () => {
    assert.equal(SCHEMA_VERSION, 20);
    const dir = mkdtempSync(join(tmpdir(), "om-v20-"));
    try {
      const path = join(dir, "state.db");
      new Store(path).close();
      const db = new DatabaseSync(path);
      try {
        const notes = cols(db, "notes");
        for (const c of ["grandfathered_at", "approved_at", "approved_by", "confirmed_at", "confirmed_by", "confirmed_kind", "confirmed_rev"]) assert.ok(notes.includes(c), c);
        assert.ok(cols(db, "quarantine").includes("forget_after"));
        assert.ok(cols(db, "quarantine").includes("confidence"));
        assert.ok(cols(db, "sessions").includes("outside_at"));
        assert.deepEqual(cols(db, "confirmations").sort(), ["at", "by", "by_authed", "id", "kind", "note_id", "note_rev", "reason", "source", "source_key"]);
        assert.deepEqual(cols(db, "note_links").sort(), ["added_at", "added_by", "derived_from", "note_id"]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v19 -> v20 upgrade of a populated store: nothing hidden, grandfathered_at stamped, one backup at v19", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-v20-"));
    try {
      const path = join(dir, "state.db");
      const s0 = new Store(path);
      for (let i = 0; i < 12; i++) s0.create({ namespace: "work", title: `deploy note ${i}`, body: `how we deploy, step ${i}` });
      s0.create({ namespace: "work", title: "web summary", body: "deploy notes from a page", tags: ["obs.origin:tool:WebFetch"] }, { kind: "summary", sessionId: "s1" });
      s0.create({ namespace: "work", title: "other topic", body: "lunch" });
      // The "before" view is what 1.3.5 showed: rows written by this v20 build are marked pre-1.4 so none of the 1.4.0 holds apply.
      s0.captureDb().prepare("UPDATE notes SET grandfathered_at = '2026-01-01T00:00:00.000Z'").run();
      const before = await snapshot(s0);
      s0.close();
      downgradeTo(path, 19);
      assert.equal(Store.peekSchemaVersion(path), 19);
      const t0 = Date.now();
      const s = quietOpen(path);
      try {
        assert.equal(Store.peekSchemaVersion(path), 20);
        assert.equal(Store.peekSchemaVersion(path + ".pre-v20-backup"), 19);
        const after = await snapshot(s);
        assert.deepEqual(after, before);
        const all = s.list({ namespace: "work", limit: 500, kinds: ["note", "summary"] }).notes;
        assert.equal(all.length, 14);
        for (const n of all) {
          assert.ok(n.grandfathered_at, `note ${n.id} stamped`);
          assert.ok(Date.parse(n.grandfathered_at!) >= t0 - 1000);
        }
        // A note written after the upgrade is not grandfathered.
        assert.equal(s.create({ namespace: "work", title: "new" }).grandfathered_at, undefined);
      } finally {
        s.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an older build refuses a v20 file", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-v20-"));
    try {
      const path = join(dir, "state.db");
      new Store(path).close();
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
      db.close();
      assert.throws(() => new Store(path), /newer|schema/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
