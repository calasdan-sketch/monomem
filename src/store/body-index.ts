// C-06 (1.5.0): keyword search over ENCRYPTED note bodies, from an index that exists only in memory.
//
// With encryption on, `body` is stored empty and the on-disk notes_fts (kept by SQL triggers that cannot decrypt) holds
// titles and tags only. This keeps a second FTS5 table in an attached `:memory:` database on the Store's own connection
// (never a TEMP table: this SQLite build puts TEMP tables in files). It indexes EVERY notes row, plain or sealed, with the
// decrypted body, so its bm25 statistics are the plain store's and ranking is identical. Search reads it instead of
// notes_fts; every visibility filter stays on the `notes` join, so nothing else changes.
//
// Kept current: TEMP triggers (this connection only) for this process's writes; other connections' commits are seen
// through PRAGMA data_version and replayed from change_log, or rebuilt in full when the log was cleared past our point.
// The decrypt function never throws: a body it cannot open is indexed as "" and counted, and the write goes on.
// Contentless (`content=''`): the inverted index only, no second copy of the text. Nothing here is written to disk by
// Monomem; the operating system can still page it to swap or a hibernation file (docs/encryption-retention.md).
// A small class over the Store; Store keeps one-line delegates. Imports `type { Store }` only.

import type { Store } from "../store.js";
import { decryptIfEncrypted, noteAad } from "../crypto.js";

/** Above this many notes the index is not built (about 7 s and 240 MB at 100k): search stays title and tags. */
export const BODY_INDEX_MAX_NOTES = 100_000;
const TABLE = "notes_fts_mem";

export interface BodyIndexInfo {
  /** off: disabled for this process (hooks, MONOMEM_BODY_INDEX=off). not built: no key, or not needed yet. */
  state: "off" | "not built" | "ready" | "too large";
  /** Rows in the index. */
  notes: number;
  /** Bodies that could not be decrypted (indexed as empty). */
  errors: number;
  /** Full builds so far in this process. */
  builds: number;
  /** Duration of the last full build. */
  buildMs: number;
}

export class BodyIndex {
  private ready = false;
  private attached = false;
  private tooLarge = false;
  private watermark = 0;
  private dataVersion = -1;
  private errors = 0;
  private builds = 0;
  private buildMs = 0;

  constructor(
    private readonly s: Store,
    private readonly enabled: boolean
  ) {}

  /** The FTS table search should read right now: the memory index when encryption is on and it can be made current. */
  table(): string {
    if (!this.enabled) return "notes_fts";
    let key: Buffer | null;
    try {
      key = this.s.writeKey();
    } catch {
      key = null; // sealed rows with the key missing: nothing can be decrypted anyway
    }
    if (!key) {
      if (this.attached) this.teardown(); // `encrypt disable`: bodies are plain again, notes_fts covers them
      return "notes_fts";
    }
    if (this.tooLarge) return "notes_fts";
    try {
      return (this.ready ? this.catchUp() : this.build()) ? TABLE : "notes_fts";
    } catch (e) {
      // ponytail: a failed build or catch-up falls back to title-and-tag search for this query (and the CLI says bodies
      // were not searched); the next search tries again from scratch.
      process.stderr.write(`monomem: body search index unavailable (${(e as Error).message}); searching titles and tags\n`);
      this.teardown();
      return "notes_fts";
    }
  }

  info(): BodyIndexInfo {
    const state = !this.enabled ? "off" : this.tooLarge ? "too large" : this.ready ? "ready" : "not built";
    const notes = this.ready ? Number((this.s.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number }).c) : 0;
    return { state, notes, errors: this.errors, builds: this.builds, buildMs: this.buildMs };
  }

  /** The plaintext of a body for the index. Never throws: a failure returns "" and is counted, so no write is aborted. */
  private plain(id: unknown, ns: unknown, body: unknown, enc: unknown): string {
    try {
      if (enc === null || enc === undefined || enc === "") return typeof body === "string" ? body : "";
      return decryptIfEncrypted(String(enc), this.s.readKey(), noteAad(Number(id), String(ns)));
    } catch {
      this.errors++;
      return "";
    }
  }

  private dv(): number {
    return Number((this.s.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version);
  }

  /** Full build. False when it cannot run now (inside a caller's transaction: ATTACH is not allowed there) or is too large. */
  private build(): boolean {
    const db = this.s.db;
    if (db.isTransaction && !this.attached) return false;
    const count = Number((db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
    if (count > BODY_INDEX_MAX_NOTES) {
      this.tooLarge = true;
      return false;
    }
    const t0 = performance.now();
    if (!this.attached) {
      db.exec("ATTACH DATABASE ':memory:' AS bodyidx");
      this.attached = true;
    }
    db.function("om_index_body", { deterministic: false }, (id, ns, body, enc) => this.plain(id, ns, body, enc));
    // data_version BEFORE the snapshot: a commit in between is then replayed once more (harmless), never missed.
    this.dataVersion = this.dv();
    this.inTx(() => {
      db.exec(`DROP TABLE IF EXISTS bodyidx.${TABLE};
        CREATE VIRTUAL TABLE bodyidx.${TABLE} USING fts5(title, body, tags, content='', contentless_delete=1, prefix='1');`);
      this.watermark = this.s.maxChangeSeq();
      db.exec(`INSERT INTO ${TABLE}(rowid, title, body, tags) SELECT id, title, om_index_body(id, namespace, body, body_enc), tags FROM notes`);
    });
    // TEMP triggers live on this connection only: other tools and older binaries never see them. A TEMP trigger may name a
    // table in an attached database (unqualified), and the attached database is part of the same transaction, so a rolled
    // back write rolls its index change back too.
    const row = `(rowid, title, body, tags) VALUES (new.id, new.title, om_index_body(new.id, new.namespace, new.body, new.body_enc), new.tags)`;
    db.exec(`
      DROP TRIGGER IF EXISTS temp.om_bodyidx_ai;
      DROP TRIGGER IF EXISTS temp.om_bodyidx_au;
      DROP TRIGGER IF EXISTS temp.om_bodyidx_ad;
      CREATE TEMP TRIGGER om_bodyidx_ai AFTER INSERT ON main.notes BEGIN
        INSERT INTO ${TABLE}${row};
      END;
      CREATE TEMP TRIGGER om_bodyidx_au AFTER UPDATE ON main.notes
      WHEN old.id IS NOT new.id OR old.title IS NOT new.title OR old.body IS NOT new.body OR old.body_enc IS NOT new.body_enc
        OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
      BEGIN
        DELETE FROM ${TABLE} WHERE rowid = old.id;
        INSERT INTO ${TABLE}${row};
      END;
      CREATE TEMP TRIGGER om_bodyidx_ad AFTER DELETE ON main.notes BEGIN
        DELETE FROM ${TABLE} WHERE rowid = old.id;
      END;
    `);
    this.ready = true;
    this.builds++;
    this.buildMs = performance.now() - t0;
    return true;
  }

  /** Replay other connections' commits from change_log (our own writes were applied by the triggers already). */
  private catchUp(): boolean {
    const v = this.dv();
    if (v === this.dataVersion) return true;
    const db = this.s.db;
    const rows = db.prepare("SELECT seq, note_id FROM change_log WHERE seq > ? ORDER BY seq").all(this.watermark) as Array<{ seq: number; note_id: number }>;
    // The log was trimmed past our point (purge, or cleared): changes may be missing, so start over.
    if ((rows.length > 0 && Number(rows[0].seq) !== this.watermark + 1) || (rows.length === 0 && this.s.maxChangeSeq() < this.watermark)) {
      this.ready = false;
      return this.build();
    }
    this.dataVersion = v;
    if (rows.length === 0) return true; // access counters and other non-note writes
    const del = db.prepare(`DELETE FROM ${TABLE} WHERE rowid = ?`);
    const ins = db.prepare(`INSERT INTO ${TABLE}(rowid, title, body, tags) SELECT id, title, om_index_body(id, namespace, body, body_enc), tags FROM notes WHERE id = ?`);
    this.inTx(() => {
      for (const id of new Set(rows.map((r) => Number(r.note_id)))) {
        del.run(id);
        ins.run(id);
      }
    });
    this.watermark = Number(rows[rows.length - 1].seq);
    return true;
  }

  /** One transaction, or the caller's if one is open. */
  private inTx(fn: () => void): void {
    const db = this.s.db;
    if (db.isTransaction) return fn();
    db.exec("BEGIN");
    try {
      fn();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  private teardown(): void {
    const db = this.s.db;
    this.ready = false;
    try {
      db.exec("DROP TRIGGER IF EXISTS temp.om_bodyidx_ai; DROP TRIGGER IF EXISTS temp.om_bodyidx_au; DROP TRIGGER IF EXISTS temp.om_bodyidx_ad;");
      if (db.isTransaction) db.exec(`DROP TABLE IF EXISTS bodyidx.${TABLE}`);
      else if (this.attached) {
        db.exec("DETACH DATABASE bodyidx");
        this.attached = false;
      }
    } catch {
      /* best effort: the triggers are gone or the connection is closing; the next build starts from DROP TABLE */
    }
  }
}
