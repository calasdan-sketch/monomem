// Store.migrate(): every schema step from an empty database to SCHEMA_VERSION, moved out of store.ts unchanged (the SQL text
// is byte-for-byte the same, so sqlite_master keeps the same CREATE statements). Store keeps a one-line delegate that hands
// in the few Store internals the steps call. Like the other src/store/ modules it never imports store.ts at runtime.
//
// A new schema version adds one `if (v < N)` step at the end of migrate() and bumps SCHEMA_VERSION in store.ts.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DEFAULT_SENSITIVITY } from "../sensitivity.js";
import { installSealSchema } from "./ledger.js";
import { CHANGE_LOG_RETENTION_DAYS, FTS_PREFIX_OPT, SQL_NOW, DEFAULT_NAMESPACE } from "./schema-constants.js";

/** The Store internals the migration steps use. */
export interface MigrateCtx {
  db: DatabaseSync;
  hasColumn(table: string, column: string): boolean;
  addColumn(table: string, column: string, decl: string): void;
  createLogTriggers(): void;
  createDeleteTrigger(): void;
  createArchiveLog(): void;
  feedKey(): Buffer;
}

/** Bring a schema at version `v` up to SCHEMA_VERSION. Caller holds the write lock. */
/**
 * Columns of capture_events that were added AFTER some dev build had already set this schema version: the version step is skipped for
 * such a database, so each is added here when it is missing (idempotent, nothing to do on a fresh or fully migrated one).
 *  - input_enc (2.0.0, v16, before release): capture inputs are sealed like outputs.
 *  - shell_fetch (v22): a shell tool call that looked like a network fetch (a weak digest hint, see shell-fetch.ts).
 */
export function ensureCaptureColumns(self: Pick<MigrateCtx, "hasColumn" | "addColumn">): void {
  if (!self.hasColumn("capture_events", "seq")) return;
  if (self.hasColumn("capture_events", "input_enc") === false) self.addColumn("capture_events", "input_enc", "TEXT");
  if (self.hasColumn("capture_events", "shell_fetch") === false) self.addColumn("capture_events", "shell_fetch", "INTEGER NOT NULL DEFAULT 0");
}

export function migrate(self: MigrateCtx, v: number): void {
    if (v < 1) {
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          namespace TEXT NOT NULL DEFAULT '${DEFAULT_NAMESPACE}',
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_namespace ON notes(namespace);
        CREATE INDEX IF NOT EXISTS idx_notes_ns_created ON notes(namespace, created_at);
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title, body, tags,
          content='notes', content_rowid='id', ${FTS_PREFIX_OPT}
        );
        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, body, tags)
          VALUES (new.id, new.title, new.body, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
          VALUES('delete', old.id, old.title, old.body, old.tags);
        END;
      `);
      // v1: note revision (compare-and-swap) + provenance source.
      self.addColumn("notes", "rev", "INTEGER NOT NULL DEFAULT 1");
      self.addColumn("notes", "source", "TEXT NOT NULL DEFAULT ''");
    }
    if (v < 2) {
      // v2: optional semantic search. One embedding per note (raw Float32
      // BLOB); ON DELETE CASCADE retires it with the note.
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS note_vectors (
          note_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          dim INTEGER NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          vec BLOB NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
    if (v < 3) {
      // v3: access tracking. access_count counts user-facing reads;
      // last_accessed is the latest read (NULL = never read). Writes leave
      // both alone.
      self.addColumn("notes", "access_count", "INTEGER NOT NULL DEFAULT 0");
      self.addColumn("notes", "last_accessed", "TEXT");
    }
    if (v < 4) {
      // v4: similarity edge graph, both directions stored, same-namespace only.
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS note_edges (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          neighbor_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          score REAL NOT NULL,
          PRIMARY KEY (note_id, neighbor_id)
        );
        CREATE INDEX IF NOT EXISTS idx_note_edges_note_id ON note_edges(note_id);
      `);
    }
    if (v < 5) {
      // v5: _meta key/value table + an FTS update trigger gated on content
      // columns (access-counter bumps must not re-index FTS).
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS _meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        DROP TRIGGER IF EXISTS notes_au;
        CREATE TRIGGER notes_au AFTER UPDATE ON notes
        WHEN (old.title IS NOT new.title OR old.body IS NOT new.body OR old.tags IS NOT new.tags)
        BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, body, tags)
          VALUES('delete', old.id, old.title, old.body, old.tags);
          INSERT INTO notes_fts(rowid, title, body, tags)
          VALUES (new.id, new.title, new.body, new.tags);
        END;
      `);
    }
    if (v < 6) {
      // v6: neighbor-direction + (note_id, score) edge indexes.
      self.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_note_edges_neighbor ON note_edges(neighbor_id);
        CREATE INDEX IF NOT EXISTS idx_note_edges_note_score ON note_edges(note_id, score DESC);
      `);
    }
    if (v < 7) {
      // v7: linter quarantine (held writes, never rows in `notes`) and
      // plain-file sync identity (sync_map) + merge base (sync_base).
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS quarantine (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          op TEXT NOT NULL,
          target_id INTEGER,
          if_rev INTEGER,
          namespace TEXT NOT NULL,
          title TEXT,
          body TEXT,
          tags TEXT,
          source TEXT,
          created_at_override TEXT,
          reasons TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_map (
          origin TEXT NOT NULL,
          origin_id INTEGER NOT NULL,
          local_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          PRIMARY KEY (origin, origin_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_map_local ON sync_map(local_id);
        CREATE TABLE IF NOT EXISTS sync_base (
          local_id INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
          hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at, id);
      `);
    }
    if (v < 8) {
      // v8: change log for the change feed. One row per note create /
      // content update / delete, written by TRIGGERS inside the writing
      // transaction: `seq` is a local, monotonic commit-order sequence and
      // `changed_at` a local stamp taken under the write lock -- never the
      // writer-supplied updated_at (imports and sync keep old updated_at).
      // Triggers also capture writes made by an older binary on the same
      // file. Access-counter bumps are not changes (rev/content unchanged).
      // Pruned to CHANGE_LOG_RETENTION_DAYS periodically (purgeChangeLog).
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS change_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          namespace TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          rev INTEGER,
          changed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_change_log_at ON change_log(changed_at);
        CREATE TRIGGER IF NOT EXISTS notes_log_ai AFTER INSERT ON notes BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (new.id, 'created', new.namespace, new.title, new.source, new.rev, ${SQL_NOW});
        END;
        CREATE TRIGGER IF NOT EXISTS notes_log_au AFTER UPDATE ON notes
        WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
              OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
              OR old.source IS NOT new.source)
        BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${SQL_NOW});
        END;
        CREATE TRIGGER IF NOT EXISTS notes_log_ad AFTER DELETE ON notes BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (old.id, 'deleted', old.namespace, old.title, old.source, NULL, ${SQL_NOW});
        END;
      `);
      // Seed the log from recent history so the first feed read after the
      // upgrade is not empty: notes changed within retention (by their
      // updated_at) and the 1.1.0-rc tombstone table, oldest first.
      const cutoff = new Date(Date.now() - CHANGE_LOG_RETENTION_DAYS * 86_400_000).toISOString();
      const hasTombstones = Boolean(
        self.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_tombstones'").get()
      );
      self.db
        .prepare(
          `INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
           SELECT id, kind, namespace, title, source, rev, at FROM (
             SELECT id, CASE WHEN rev = 1 THEN 'created' ELSE 'updated' END AS kind,
                    namespace, title, source, rev, updated_at AS at
               FROM notes WHERE updated_at >= ?
             ${hasTombstones
               ? `UNION ALL SELECT note_id, 'deleted', namespace, title, source, NULL, deleted_at
                    FROM note_tombstones WHERE deleted_at >= ?`
               : ""}
           ) ORDER BY at, id`
        )
        .run(...(hasTombstones ? [cutoff, cutoff] : [cutoff]));
      self.db.exec("DROP TABLE IF EXISTS note_tombstones");
      // 1.1.0-rc "last" markers used another key/value format.
      self.db.exec("DELETE FROM _meta WHERE key LIKE 'changes_seen:%'");
      // Quarantined updates remember whether the original patch moved the
      // note; approval re-applies the namespace only then.
      self.addColumn("quarantine", "set_namespace", "INTEGER NOT NULL DEFAULT 0");
    }
    if (v < 9) {
      // v9 (a) sync_deleted: deleting a note that came from another machine
      // must not resurrect it on the next import. sync_map/sync_base cascade
      // away with the note, so a BEFORE DELETE trigger keeps its identity +
      // merge base here; import skips the file unless it changed since.
      // (b) change_log privacy: a deleted note's titles are blanked, and a
      // rename keeps only the latest title, so /changes doesn't hold old
      // titles for the whole retention window.
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS sync_deleted (
          origin TEXT NOT NULL,
          origin_id INTEGER NOT NULL,
          hash TEXT,
          PRIMARY KEY (origin, origin_id)
        );
        CREATE TRIGGER IF NOT EXISTS notes_sync_bd BEFORE DELETE ON notes BEGIN
          INSERT OR REPLACE INTO sync_deleted (origin, origin_id, hash)
          SELECT m.origin, m.origin_id, (SELECT b.hash FROM sync_base b WHERE b.local_id = old.id)
            FROM sync_map m WHERE m.local_id = old.id;
        END;
        CREATE INDEX IF NOT EXISTS idx_change_log_note ON change_log(note_id);
        DROP TRIGGER IF EXISTS notes_log_ad;
        CREATE TRIGGER notes_log_ad AFTER DELETE ON notes BEGIN
          UPDATE change_log SET title = '' WHERE note_id = old.id AND title <> '';
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (old.id, 'deleted', old.namespace, '', old.source, NULL, ${SQL_NOW});
        END;
        DROP TRIGGER IF EXISTS notes_log_au;
        CREATE TRIGGER notes_log_au AFTER UPDATE ON notes
        WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
              OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
              OR old.source IS NOT new.source)
        BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${SQL_NOW});
          UPDATE change_log SET title = ''
           WHERE old.title IS NOT new.title AND note_id = new.id AND title <> ''
             AND seq < (SELECT max(seq) FROM change_log WHERE note_id = new.id);
        END;
      `);
      self.db.exec("UPDATE change_log SET title = '' WHERE kind = 'deleted' OR note_id NOT IN (SELECT id FROM notes)");
    }
    if (v < 10) {
      // v10 (a) at-rest encryption: body_enc holds the AES-256-GCM envelope.
      //     When encryption is enabled the plaintext `body` column is left
      //     EMPTY for encrypted notes so the external-content FTS5 index
      //     never ingests ciphertext (it would match base64 noise). Search
      //     therefore covers title+tags for encrypted notes; that tradeoff is
      //     documented, not hidden. `body` stays the FTS source, unchanged.
      // (b) retention: expires_at (TTL deadline) + archived_at (soft delete).
      self.addColumn("notes", "body_enc", "TEXT");
      self.addColumn("notes", "expires_at", "TEXT");
      self.addColumn("notes", "archived_at", "TEXT");
      // Archived notes drop out of the default list/search paths; this index
      // keeps the archive view cheap without touching the live-note indexes.
      self.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(archived_at, id)"
      );
    }
    if (v < 11) {
      // v11 (a) archive/restore are changes: add archived_at to the update
      //     trigger's WHEN clause so the change feed (and sync consumers)
      //     see a note being archived or restored. (b) quarantine.sealed:
      //     1 when title/body/tags are stored as encrypted envelopes.
      self.addColumn("quarantine", "sealed", "INTEGER NOT NULL DEFAULT 0");
      self.db.exec(`
        DROP TRIGGER IF EXISTS notes_log_au;
        CREATE TRIGGER notes_log_au AFTER UPDATE ON notes
        WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
              OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
              OR old.source IS NOT new.source OR old.archived_at IS NOT new.archived_at)
        BEGIN
          INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
          VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${SQL_NOW});
          UPDATE change_log SET title = ''
           WHERE old.title IS NOT new.title AND note_id = new.id AND title <> ''
             AND seq < (SELECT max(seq) FROM change_log WHERE note_id = new.id);
        END;
      `);
    }
    if (v < 12) {
      // v12: change_log.actor = the label of the token / connection that made
      //     the write (NOT the note's free-form `source`), so exclude_self
      //     hides a consumer's own writes and nothing else. Rows written
      //     before this version, by the CLI, by scripts or by any other tool
      //     carry '' and fall back to `source` when filtered. The stamping is
      //     done per connection by a TEMP trigger (see installActorStamp), so
      //     the stored triggers are unchanged and foreign writers still work.
      self.addColumn("change_log", "actor", "TEXT NOT NULL DEFAULT ''");
    }
    if (v < 13) {
      // v13: server-stamped writer identity ("Who wrote this?"). written_by =
      //     the last writer (token label, or the stdio / cli / server marker),
      //     created_by = the first writer, imported_written_by = what an import
      //     payload CLAIMED. Old rows get '' = unknown (never guessed from the
      //     client-asserted `source`). Plaintext like title/tags. change_log and
      //     quarantine carry the writer too, so the feed can filter on it and an
      //     approved quarantined write keeps its real author.
      self.addColumn("notes", "written_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("notes", "created_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("notes", "imported_written_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("change_log", "written_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("quarantine", "written_by", "TEXT NOT NULL DEFAULT ''");
      // The permanent change_log triggers copy the NOTE's writer, so the feed
      // can never disagree with the row (quarantine approval, imports, and
      // writers that never register a function all stay correct).
      self.createLogTriggers();
      // Composite index shaped like the list / search queries (namespace +
      // writer filter, newest first). A bare index on the writer column is
      // very low cardinality (most rows share one value) and made the planner
      // scan and sort nearly the whole table.
      self.db.exec("DROP INDEX IF EXISTS idx_notes_written_by");
      self.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_ns_writer ON notes(namespace, written_by, updated_at DESC)");
    }
    if (v < 14) {
      // v14: the trust layer.
      //  - notes: imported_created_by (the payload's unverified first-writer
      //    claim), attested_writer / attested_by (a writer a TRUSTED server
      //    vouched for, see attest.ts) and merged_from_writers (a JSON array of
      //    the writers whose notes a consolidation merged: kept for good).
      //  - change_log: a delete row remembers who wrote the note it deleted
      //    (note_written_by, plus the attested / merged writers), so the feed can
      //    filter on a note's author even after the note is gone.
      //  - trust_distrust: the admin-managed per-namespace list of distrusted
      //    writers. trust_attesters: public keys whose export attestations the
      //    admin trusts. Both live in the database, never in a note, so a write
      //    token cannot touch them.
      //  - a stable per-database server_id (the existing `store_uuid` in _meta),
      //    minted here so it exists before anything asks for it.
      self.addColumn("notes", "imported_created_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("notes", "attested_writer", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("notes", "attested_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("notes", "merged_from_writers", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("change_log", "note_written_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("change_log", "note_attested_writer", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("change_log", "note_attested_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("change_log", "note_merged_from", "TEXT NOT NULL DEFAULT ''");
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS trust_distrust (
          namespace TEXT NOT NULL,
          writer TEXT NOT NULL,
          added_at TEXT NOT NULL,
          added_by TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (namespace, writer)
        );
        CREATE TABLE IF NOT EXISTS trust_attesters (
          key_id TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          server_id TEXT NOT NULL DEFAULT '',
          label TEXT NOT NULL DEFAULT '',
          added_at TEXT NOT NULL,
          added_by TEXT NOT NULL DEFAULT '',
          not_after TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS trust_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT '',
          subject TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_change_log_writer ON change_log(written_by, seq);
      `);
      self.createDeleteTrigger();
      self.db.prepare("INSERT OR IGNORE INTO _meta (key, value) VALUES ('store_uuid', ?)").run(randomUUID());
    }
    if (v < 15) {
      // v15 (1.6.0): replacing a memory is never silent, never destructive, and never a one-way door.
      //  - notes.confidence / confidence_by: an optional CLAIM (0..1) and the writer who made it.
      //  - notes.superseded_by / superseded_at / superseded_by_writer: a note a confirmed replacement retired. The note is also
      //    archived (archived_at), so every existing read path already leaves it out; these columns say WHY and by what.
      //  - note_history: earlier titles and bodies of a note (bounded per note), so a bad overwrite can be undone. Bodies are
      //    sealed like note bodies when at-rest encryption is on. Gone with the note on a hard delete.
      //  - supersede_used: single-use marks for confirmation tokens (a token works once).
      //  - supersede_log: who retired / restored what, and when (kept; the notes themselves are never deleted).
      self.addColumn("notes", "confidence", "REAL");
      self.addColumn("notes", "confidence_by", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("notes", "superseded_by", "INTEGER");
      self.addColumn("notes", "superseded_at", "TEXT");
      self.addColumn("notes", "superseded_by_writer", "TEXT NOT NULL DEFAULT ''");
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS note_history (
          hid INTEGER PRIMARY KEY AUTOINCREMENT,
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          body_enc TEXT,
          tags TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          written_by TEXT NOT NULL DEFAULT '',
          claimed_writer TEXT NOT NULL DEFAULT '',
          imported INTEGER NOT NULL DEFAULT 0,
          merged_from TEXT NOT NULL DEFAULT '',
          confidence REAL,
          saved_at TEXT NOT NULL,
          saved_by TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT 'update',
          bytes INTEGER NOT NULL DEFAULT 0,
          UNIQUE (note_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_note_history_note ON note_history(note_id, version);
        CREATE TABLE IF NOT EXISTS supersede_used (
          nonce TEXT PRIMARY KEY,
          used_at TEXT NOT NULL,
          expires_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS supersede_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          namespace TEXT NOT NULL DEFAULT '',
          old_id INTEGER NOT NULL,
          new_id INTEGER,
          flags TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_notes_superseded ON notes(superseded_by);
      `);
      // The confirmation-token key is made now (a preview must write nothing).
      self.feedKey();
    }
    if (v < 16) {
      // v16 (2.0.0): automatic memory. Captured observations and session summaries are ordinary notes rows with a kind, so
      // they inherit lint, quarantine, history, FTS and trust. Every existing read asks for kind 'note' only (RangeOpts.kinds).
      //  - sessions: one row per agent session (cwd, counts, how far the distiller got, its summary note).
      //  - capture_events: raw hook events, short-lived (MONOMEM_CAPTURE_RETENTION_DAYS, see sweepCaptureEvents), never
      //    synced. `output` / `input` are sealed into output_enc / input_enc like a note body when at-rest encryption is on.
      //  - note_files: which files an observation read or changed (gone with the note).
      //  - file_context_seen: which files a session was already shown context for.
      self.addColumn("notes", "kind", "TEXT NOT NULL DEFAULT 'note'");
      self.addColumn("notes", "session_id", "TEXT NOT NULL DEFAULT ''");
      self.addColumn("notes", "obs_type", "TEXT NOT NULL DEFAULT ''");
      self.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notes_kind_session ON notes(namespace, kind, session_id, created_at);
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          namespace TEXT NOT NULL DEFAULT '',
          cwd TEXT NOT NULL DEFAULT '',
          agent TEXT NOT NULL DEFAULT 'claude-code',
          started_at TEXT NOT NULL,
          ended_at TEXT,
          prompt_count INTEGER NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0,
          distilled_seq INTEGER NOT NULL DEFAULT 0,
          summary_note_id INTEGER
        );
        CREATE TABLE IF NOT EXISTS capture_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          at TEXT NOT NULL,
          event TEXT NOT NULL,
          tool TEXT NOT NULL DEFAULT '',
          input TEXT NOT NULL DEFAULT '',
          input_enc TEXT,
          output TEXT NOT NULL DEFAULT '',
          output_enc TEXT,
          ok INTEGER NOT NULL DEFAULT 1,
          bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_capture_events_session ON capture_events(session_id, seq);
        CREATE TABLE IF NOT EXISTS note_files (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          action TEXT NOT NULL,
          PRIMARY KEY (note_id, path, action)
        );
        CREATE INDEX IF NOT EXISTS idx_note_files_path ON note_files(path);
        CREATE TABLE IF NOT EXISTS file_context_seen (
          session_id TEXT NOT NULL,
          path TEXT NOT NULL,
          PRIMARY KEY (session_id, path)
        );
      `);
    }
    if (v < 17) {
      // v17: who read what, and the flood guard's write counter.
      //  - access_log: one row per memory read (when, writer identity, tool or route, namespaces, a short redacted query
      //    preview, how many results). Never note text or titles. The preview is sealed when at-rest encryption is on.
      //    Kept MONOMEM_ACCESS_LOG_DAYS (sweepExpired).
      //  - write_rate: one row per counted create/update, per writer, for the rolling-hour flood check. Kept one hour.
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS access_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          writer TEXT NOT NULL DEFAULT '',
          tool TEXT NOT NULL,
          namespaces TEXT NOT NULL DEFAULT '',
          query TEXT NOT NULL DEFAULT '',
          results INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_access_log_at ON access_log(at);
        CREATE TABLE IF NOT EXISTS write_rate (
          writer TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_write_rate ON write_rate(writer, at);
      `);
    }
    if (v < 18) {
      // v18: human-only notes and rollback by writer.
      //  - notes.pinned: 1 = the operator pinned the note; only the local CLI may change it (see refuseAgentOnPinned). A column, not
      //    a _meta list, so every read path shows it for free and an older build refuses this file (user_version) instead of
      //    opening it and silently ignoring the pins.
      //  - note_history_dropped: per note and per writer, when the versions that writer replaced were dropped from note_history
      //    (pruned by the limits, or purged). No text. Lets a rollback say "cannot fully undo" instead of guessing.
      self.addColumn("notes", "pinned", "INTEGER NOT NULL DEFAULT 0");
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS note_history_dropped (
          note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          saved_by TEXT NOT NULL,
          first_at TEXT NOT NULL,
          last_at TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (note_id, saved_by)
        );
      `);
      //  - archive_log (+ triggers): archive/restore history for --as-of. Part of v18, so the migration (one transaction, under the
      //    write lock) creates it once and a failure aborts the upgrade instead of being swallowed.
      self.createArchiveLog();
    }
    if (v < 19) {
      // v19: per-memory sensitivity labels (public < internal < private; see src/sensitivity.ts).
      //  - notes.sensitivity: every existing note becomes "internal" (the default), so nothing changes for anyone until a
      //    label is set. The column is NOT NULL, so a row can never be "unlabelled"; an unknown value is hidden from every
      //    token that has a ceiling.
      //  - change_log.note_sensitivity: the label a note had when it was deleted (the delete row outlives the note, and the
      //    change feed must be able to hide it from a restricted token). Older delete rows read "internal".
      //  - quarantine.sensitivity: the label a held write carries, so approving it does not quietly relabel the note.
      // An older build refuses a v19 file ("newer than this build supports") instead of opening it and ignoring the labels.
      self.addColumn("notes", "sensitivity", `TEXT NOT NULL DEFAULT '${DEFAULT_SENSITIVITY}'`);
      self.addColumn("change_log", "note_sensitivity", `TEXT NOT NULL DEFAULT '${DEFAULT_SENSITIVITY}'`);
      self.addColumn("quarantine", "sensitivity", `TEXT NOT NULL DEFAULT '${DEFAULT_SENSITIVITY}'`);
      self.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_ns_sensitivity ON notes(namespace, sensitivity)");
      // The default list (newest first inside one namespace) read and sorted the whole namespace; this index serves it in order.
      self.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_ns_updated ON notes(namespace, updated_at DESC, id DESC)");
      self.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_live_updated ON notes(archived_at, updated_at DESC, id DESC)");
      self.createDeleteTrigger();
    }
    if (v < 20) {
      // v20 (1.4.0): trust. Everything the release needs lands in this one step (one backup, one transaction).
      //  - notes.grandfathered_at: when the upgrade ran, for every note that existed then (new notes leave it NULL). Notes
      //    from before the upgrade are exempt from the new holds, and any re-confirmation clock starts here, so upgrading
      //    hides nothing.
      //  - notes.approved_at / approved_by: a held write that was approved (its created_at/updated_at keep the WRITTEN time).
      //  - notes.confirmed_*: the latest qualifying confirm (kind human|admin|corroborated), valid only while confirmed_rev = rev.
      //  - quarantine.forget_after / confidence: a held write keeps them, so approving it applies them.
      //  - sessions.outside_at: when a captured session last read outside content (web, other MCP servers).
      //  - confirmations: every confirm, counted or not (who, whether authenticated, what source they named; kind
      //    'not_counted' with the rule in `reason`).
      //  - note_links: add-only "derived from" links between notes.
      for (const c of ["grandfathered_at", "approved_at", "approved_by", "confirmed_at", "confirmed_by", "confirmed_kind"]) self.addColumn("notes", c, "TEXT");
      self.addColumn("notes", "confirmed_rev", "INTEGER");
      // 1 = the last content write by the local CLI ran at a terminal (stdin and stdout); see retroTaint.
      self.addColumn("notes", "cli_tty", "INTEGER");
      self.addColumn("quarantine", "forget_after", "INTEGER");
      self.addColumn("quarantine", "confidence", "REAL");
      // A held edit that CLEARS its confidence or forget date (null): a JSON list of those field names, applied on approval.
      self.addColumn("quarantine", "clears", "TEXT");
      self.addColumn("sessions", "outside_at", "TEXT");
      // The taint window asks "open sessions of this namespace" on every agent write.
      self.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_ns_open ON sessions(namespace, ended_at)");
      self.db.exec(`
        CREATE TABLE IF NOT EXISTS confirmations (
          id INTEGER PRIMARY KEY,
          note_id INTEGER NOT NULL,
          note_rev INTEGER NOT NULL,
          at TEXT NOT NULL,
          by TEXT NOT NULL,
          by_authed INTEGER NOT NULL,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          source_key TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_confirm_note ON confirmations(note_id, at);
        CREATE TABLE IF NOT EXISTS note_links (
          note_id INTEGER NOT NULL,
          derived_from INTEGER NOT NULL,
          added_at TEXT NOT NULL,
          added_by TEXT NOT NULL,
          PRIMARY KEY (note_id, derived_from)
        );
        CREATE INDEX IF NOT EXISTS idx_links_parent ON note_links(derived_from);
      `);
      self.db.prepare("UPDATE notes SET grandfathered_at = ? WHERE grandfathered_at IS NULL").run(new Date().toISOString());
    }
    if (v < 21) {
      // v21 (1.5.0): everything round 1 of 1.5.0 needs, in this one step (one backup, one transaction). Later 1.5.0 items add
      // their columns here too: the release ships as one schema bump. Every step is idempotent.
      //  - notes.content_at: when the TITLE or BODY last changed (or the held write was written). The re-confirmation clock
      //    starts from this, not from updated_at, so a tag/confidence/TTL edit or a corroboration can no longer restart it.
      //    Existing notes get their updated_at, except a note whose current version carries a corroborated confirm: that
      //    confirm used to restart the clock, so its time is kept and upgrading changes no due date (hides nothing).
      //  - notes.writer_cwd: the folder of the local, unauthenticated process that last wrote the content (stdio server launch
      //    folder, or the CLI at a non-terminal). Taint windows are matched by folder, not by the namespace the writer names.
      //    Never exported or synced. NULL = unknown origin.
      if (!self.hasColumn("notes", "content_at")) {
        self.addColumn("notes", "content_at", "TEXT");
        self.db.exec(
          `UPDATE notes SET content_at = CASE WHEN confirmed_kind = 'corroborated' AND confirmed_rev = rev AND confirmed_at > updated_at THEN confirmed_at ELSE updated_at END WHERE content_at IS NULL`
        );
      }
      self.addColumn("notes", "writer_cwd", "TEXT");
      //  - capture_events.spool_id: the id a spooled hook event carries; a second insert of the same id is ignored, so a drain cut
      //    off after the insert cannot store (and count) an event twice (R1-13). Live hook events have NULL.
      //  - notes_links_ad: deleting a note removes its note_links rows (either column) and its confirmations, so no row names an id
      //    that no longer exists (and a later note that reuses the id cannot inherit them). Orphans already there are removed.
      //  - idx_notes_origin: a partial index over the notes the unconfirmed scan looks at (stamped, live, not grandfathered), so
      //    session start does not read the whole table (R1-16). Its WHERE terms are repeated verbatim in Store.unconfirmedSql.
      self.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_origin ON notes(namespace) WHERE tags LIKE '%obs.origin:%' AND archived_at IS NULL AND grandfathered_at IS NULL");
      self.addColumn("capture_events", "spool_id", "TEXT");
      self.db.exec(`
        DELETE FROM note_links WHERE note_id NOT IN (SELECT id FROM notes) OR derived_from NOT IN (SELECT id FROM notes);
        DELETE FROM confirmations WHERE note_id NOT IN (SELECT id FROM notes);
        DROP TRIGGER IF EXISTS notes_links_ad;
        CREATE TRIGGER notes_links_ad AFTER DELETE ON notes BEGIN
          DELETE FROM note_links WHERE note_id = old.id OR derived_from = old.id;
          DELETE FROM confirmations WHERE note_id = old.id;
        END;
      `);
      self.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_spool ON capture_events(spool_id) WHERE spool_id IS NOT NULL");
    }
    if (v < 22) {
      // capture_events.shell_fetch: 1 when a shell tool call looked like a network fetch (a weak digest hint, see shell-fetch.ts). Old rows are 0.
      self.addColumn("capture_events", "shell_fetch", "INTEGER NOT NULL DEFAULT 0");
      // v22 (1.5.0, round 2): one more step for the round-2 items (one backup, one transaction). Unreleased: later round-2
      // items add their tables HERE. To add a table: CREATE it in this exec, add its "DELETE FROM <table> WHERE note_id =
      // old.id;" line to the notes_links_ad trigger at the end, and drop it in test/legacy-db.ts (the v22 block). Idempotent.
      //  - F-05: idx_note_edges_note_id is a prefix of note_edges' primary key (pure write cost): dropped. (archived_at, kind)
      //    makes the unfiltered live COUNT covering.
      //  - note_flags (R2-02): "this looks wrong" flags. Nothing in the note changes; a flag names the rev it was about.
      //  - note_client_keys (R2-04): idempotency keys on note writes, per writer, stored hashed (never the raw key).
      //  - writer_events (R2-08): what happened to a writer's writes (held by the linter, rejected, rolled back, flag upheld,
      //    replaced), for the counts `monomem trust` shows. Counts only: no row outlives its usefulness by naming content, and
      //    the rows stay when a note is deleted (the count is about the writer, not the note).
      //  - code_anchors (R2-03): the files a note is about, each with its git blob, the commit and the repository root at
      //    write time. Plain paths (like note_files), never note text.
      //  - idx_notes_obs, idx_notes_tag_task, idx_notes_tag_convention, idx_notes_kind_summary, idx_notes_pinned,
      //    idx_notes_facts (round 4, 100k gate): session start's decisions, conventions, open-task count, latest summary, pinned
      //    notes and fact notes read only those rows, not the whole namespace. The partial ones are named in the query (INDEXED
      //    BY, see TAG_INDEXES, pinnedNotes, liveFactNotesIn) because the planner cannot tell a rare row from a common one.
      self.db.exec(`
        DROP INDEX IF EXISTS idx_note_edges_note_id;
        CREATE INDEX IF NOT EXISTS idx_notes_live_kind ON notes(archived_at, kind);
        CREATE INDEX IF NOT EXISTS idx_notes_obs ON notes(obs_type, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_tag_task ON notes(updated_at DESC, id DESC) WHERE instr(tags, '"task"') > 0;
        CREATE INDEX IF NOT EXISTS idx_notes_tag_convention ON notes(updated_at DESC, id DESC) WHERE instr(tags, '"convention"') > 0;
        CREATE INDEX IF NOT EXISTS idx_notes_kind_summary ON notes(updated_at DESC, id DESC) WHERE kind = 'summary';
        CREATE INDEX IF NOT EXISTS idx_notes_pinned ON notes(id) WHERE pinned = 1;
        CREATE INDEX IF NOT EXISTS idx_notes_facts ON notes(id) WHERE tags LIKE '%"fact:%' AND archived_at IS NULL AND superseded_at IS NULL;
        CREATE TABLE IF NOT EXISTS note_flags (
          id INTEGER PRIMARY KEY,
          note_id INTEGER NOT NULL,
          note_rev INTEGER NOT NULL,
          flagged_by TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          at TEXT NOT NULL,
          tainted INTEGER NOT NULL DEFAULT 0,
          cleared_at TEXT,
          cleared_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_note_flags_note ON note_flags(note_id, note_rev);
        CREATE INDEX IF NOT EXISTS idx_note_flags_by ON note_flags(flagged_by, at);
        CREATE TABLE IF NOT EXISTS note_client_keys (
          writer TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          note_id INTEGER NOT NULL,
          at TEXT NOT NULL,
          PRIMARY KEY (writer, key_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_note_client_keys_note ON note_client_keys(note_id);
        CREATE TABLE IF NOT EXISTS writer_events (
          id INTEGER PRIMARY KEY,
          writer TEXT NOT NULL,
          event TEXT NOT NULL,
          note_id INTEGER,
          at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_writer_events ON writer_events(at, writer);
        CREATE TABLE IF NOT EXISTS code_anchors (
          note_id INTEGER NOT NULL,
          path TEXT NOT NULL,
          blob TEXT NOT NULL,
          commit_sha TEXT NOT NULL,
          repo_root TEXT NOT NULL,
          at TEXT NOT NULL,
          PRIMARY KEY (note_id, path)
        );
        DELETE FROM code_anchors WHERE note_id NOT IN (SELECT id FROM notes);
        DELETE FROM note_flags WHERE note_id NOT IN (SELECT id FROM notes);
        DELETE FROM note_client_keys WHERE note_id NOT IN (SELECT id FROM notes);
        DROP TRIGGER IF EXISTS notes_links_ad;
        CREATE TRIGGER notes_links_ad AFTER DELETE ON notes BEGIN
          DELETE FROM note_links WHERE note_id = old.id OR derived_from = old.id;
          DELETE FROM confirmations WHERE note_id = old.id;
          DELETE FROM note_flags WHERE note_id = old.id;
          DELETE FROM note_client_keys WHERE note_id = old.id;
          DELETE FROM code_anchors WHERE note_id = old.id;
        END;
      `);
    }    if (v < 23) {
      // v23 (1.8.0): per-note seal + hash-chained ledger. Additive: one column, two tables, indexes, three triggers; no row is
      // rewritten here (the seals are made in short batches after open, see store/ledger.ts backfillBatch), so a 100k-note
      // upgrade does not hold the write lock for the whole job. The pre-migration backup is made by Store.init as for every step.
      installSealSchema(self.db);
    }
  }
