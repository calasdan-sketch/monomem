import { mkdtempSync, cpSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os";
const root = process.argv[2], src = process.argv[3]; const d = mkdtempSync(join(tmpdir(), "mm-sp-")); cpSync(src, d, { recursive: true });
Object.assign(process.env, { MONOMEM_HOME: d, ONEMEMORY_HOME: d, MONOMEM_AUDIT_LOG: join(d, "a.log") });
const { Store } = await import(`file:///${root}/dist/src/store.js`); const store = new Store(join(d, "state.db")); const db = store.db;
const Q = {
  cur: "SELECT note_id FROM note_vectors WHERE note_id IN (SELECT id FROM notes WHERE archived_at IS NOT NULL AND superseded_by IS NULL)",
  gt: "SELECT note_id FROM note_vectors WHERE note_id IN (SELECT id FROM notes WHERE archived_at > '' AND superseded_by IS NULL)",
  hint: "SELECT note_id FROM note_vectors WHERE note_id IN (SELECT id FROM notes INDEXED BY idx_notes_archived WHERE archived_at IS NOT NULL AND superseded_by IS NULL)",
  exp_cur: "SELECT id FROM notes WHERE expires_at IS NOT NULL AND expires_at <= '2026-11-26' AND archived_at IS NULL AND pinned = 0",
  exp_hint: "SELECT id FROM notes INDEXED BY idx_notes_live_kind WHERE expires_at IS NOT NULL AND expires_at <= '2026-11-26' AND archived_at IS NULL AND pinned = 0",
};
for (const [k, q] of Object.entries(Q)) { const a = []; for (let i = 0; i < 7; i++) { const t = performance.now(); db.prepare(q).all(); a.push(performance.now() - t); } a.sort((x, y) => x - y); console.log(k, a[3].toFixed(1), db.prepare("EXPLAIN QUERY PLAN " + q).all().map((r) => r.detail).join(" ; ")); }
