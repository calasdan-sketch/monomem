// 1.5.0 (round 2, F-01/F-02): session start skips the list COUNTs and reads ids without decrypting; results unchanged.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { injectContext } from "../src/context-inject.js";

function seed(s: Store): void {
  for (let i = 0; i < 30; i++) {
    s.create({ namespace: i % 2 ? "a" : "b", title: `Decision: note ${i}`, body: `body ${i} kalo`, tags: i % 5 === 0 ? ["convention"] : i % 7 === 0 ? ["task"] : [] });
  }
}

test("F-01 list({count:false}) returns the same notes; total is the page size", () => {
  const s = new Store(":memory:");
  try {
    seed(s);
    const full = s.list({ namespace: "a", limit: 5, withoutTags: ["task"] });
    const lean = s.list({ namespace: "a", limit: 5, withoutTags: ["task"], count: false });
    assert.deepEqual(lean.notes.map((n) => n.id), full.notes.map((n) => n.id));
    assert.ok(full.total > 5, "default still counts the whole set");
    assert.equal(lean.total, lean.notes.length);
  } finally {
    s.close();
  }
});

test("F-01 session start runs only the two COUNTs it prints (notes total, open tasks)", async () => {
  const s = new Store(":memory:");
  try {
    seed(s);
    const sig = { namespace: "a", signals: { branch: "feat/kalo", diffFiles: [] } };
    await injectContext(s, sig); // warm
    const db = s.captureDb() as unknown as { prepare: (sql: string) => unknown };
    const orig = db.prepare.bind(db);
    let counts = 0;
    db.prepare = (sql: string) => {
      if (/COUNT\(\*\)/i.test(sql) && /FROM notes\b/i.test(sql)) counts++;
      return orig(sql);
    };
    try {
      await injectContext(s, sig);
    } finally {
      db.prepare = orig as never;
    }
    assert.ok(counts <= 2, `COUNT(*) FROM notes ran ${counts} times`);
  } finally {
    s.close();
  }
});

test("F-02 listIds matches list() ids and never decrypts a body", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-f02-"));
  try {
    ensureKey(dir);
    const s = new Store(join(dir, "state.db"));
    seed(s);
    const opts = { namespace: "a", withoutTags: ["task", "handoff"], limit: 500 };
    const want = s.list(opts).notes.map((n) => n.id);
    let recs = 0;
    const raw = s as unknown as { rec: (r: unknown) => unknown };
    const orig = raw.rec.bind(s);
    raw.rec = (r) => (recs++, orig(r));
    const got = s.listIds(opts);
    raw.rec = orig;
    assert.deepEqual(got, want);
    assert.equal(recs, 0, "no row was decrypted");
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
