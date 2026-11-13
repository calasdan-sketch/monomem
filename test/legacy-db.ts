// Test helper: turn a freshly written database into the file an OLDER release
// would have left behind (schema v11, v12 or v13), so migration tests start
// from the real shapes. It only removes what the newer schema added and puts
// back the older triggers; the rows stay.
import { DatabaseSync } from "node:sqlite";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const V11_TRIGGERS = `
  CREATE TRIGGER notes_log_ai AFTER INSERT ON notes BEGIN
    INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
    VALUES (new.id, 'created', new.namespace, new.title, new.source, new.rev, ${NOW});
  END;
  CREATE TRIGGER notes_log_au AFTER UPDATE ON notes
  WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
        OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
        OR old.source IS NOT new.source OR old.archived_at IS NOT new.archived_at)
  BEGIN
    INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
    VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${NOW});
    UPDATE change_log SET title = ''
     WHERE old.title IS NOT new.title AND note_id = new.id AND title <> ''
       AND seq < (SELECT max(seq) FROM change_log WHERE note_id = new.id);
  END;
`;

const V13_TRIGGERS = `
  CREATE TRIGGER notes_log_ai AFTER INSERT ON notes BEGIN
    INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at, written_by)
    VALUES (new.id, 'created', new.namespace, new.title, new.source, new.rev, ${NOW}, new.written_by);
  END;
  CREATE TRIGGER notes_log_au AFTER UPDATE ON notes
  WHEN (old.rev IS NOT new.rev OR old.title IS NOT new.title OR old.body IS NOT new.body
        OR old.tags IS NOT new.tags OR old.namespace IS NOT new.namespace
        OR old.source IS NOT new.source OR old.archived_at IS NOT new.archived_at)
  BEGIN
    INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at, written_by)
    VALUES (new.id, 'updated', new.namespace, new.title, new.source, new.rev, ${NOW}, new.written_by);
    UPDATE change_log SET title = ''
     WHERE old.title IS NOT new.title AND note_id = new.id AND title <> ''
       AND seq < (SELECT max(seq) FROM change_log WHERE note_id = new.id);
  END;
`;

const OLD_DELETE_TRIGGER = `
  CREATE TRIGGER notes_log_ad AFTER DELETE ON notes BEGIN
    UPDATE change_log SET title = '' WHERE note_id = old.id AND title <> '';
    INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at)
    VALUES (old.id, 'deleted', old.namespace, '', old.source, NULL, ${NOW});
  END;
`;

// The delete trigger as v14 through v16 had it (no deleted-note label yet).
const V14_DELETE_TRIGGER = `
  CREATE TRIGGER notes_log_ad AFTER DELETE ON notes BEGIN
    UPDATE change_log SET title = '' WHERE note_id = old.id AND title <> '';
    INSERT INTO change_log (note_id, kind, namespace, title, source, rev, changed_at,
                            note_written_by, note_attested_writer, note_attested_by, note_merged_from)
    VALUES (old.id, 'deleted', old.namespace, '', old.source, NULL, ${NOW},
            old.written_by, old.attested_writer, old.attested_by, old.merged_from_writers);
  END;
`;

/** Rewrite the database file at `path` (closed by the caller) as it looked at `version`. */
export function downgradeTo(path: string, version: 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19): void {
  const raw = new DatabaseSync(path);
  try {
    // v20 additions (1.4.0 trust: approval/confirm columns, confirmations, note_links), removed for every older shape.
    raw.exec("DROP TABLE IF EXISTS confirmations; DROP TABLE IF EXISTS note_links;");
    for (const c of ["grandfathered_at", "approved_at", "approved_by", "confirmed_at", "confirmed_by", "confirmed_kind", "confirmed_rev"]) raw.exec(`ALTER TABLE notes DROP COLUMN ${c}`);
    raw.exec("ALTER TABLE quarantine DROP COLUMN forget_after; ALTER TABLE quarantine DROP COLUMN confidence; ALTER TABLE sessions DROP COLUMN outside_at;");
    if (version === 19) {
      raw.exec("PRAGMA user_version = 19");
      return;
    }
    // v19 additions (per-memory sensitivity labels), removed for every older shape. The delete trigger names the new
    // columns, so it goes first; the v14-style one is put back for the shapes that keep it.
    raw.exec("DROP TRIGGER IF EXISTS notes_log_ad; DROP INDEX IF EXISTS idx_notes_ns_sensitivity; DROP INDEX IF EXISTS idx_notes_ns_updated; DROP INDEX IF EXISTS idx_notes_live_updated;");
    raw.exec("ALTER TABLE notes DROP COLUMN sensitivity; ALTER TABLE change_log DROP COLUMN note_sensitivity; ALTER TABLE quarantine DROP COLUMN sensitivity;");
    raw.exec(V14_DELETE_TRIGGER);
    if (version === 18) {
      raw.exec("PRAGMA user_version = 18");
      return;
    }
    // v18 additions, removed for every older shape.
    raw.exec("DROP TABLE IF EXISTS note_history_dropped; ALTER TABLE notes DROP COLUMN pinned;");
    raw.exec("DROP TRIGGER IF EXISTS notes_archive_log_au; DROP TRIGGER IF EXISTS notes_archive_log_ad; DROP TABLE IF EXISTS archive_log; DELETE FROM _meta WHERE key = 'archive_log_since';");
    if (version === 17) {
      raw.exec("PRAGMA user_version = 17");
      return;
    }
    // v17 additions, removed for every older shape.
    raw.exec("DROP TABLE IF EXISTS access_log; DROP TABLE IF EXISTS write_rate;");
    if (version === 16) {
      raw.exec("PRAGMA user_version = 16");
      return;
    }
    // v16 additions (2.0.0), removed for every older shape.
    raw.exec("DROP INDEX IF EXISTS idx_notes_kind_session; DROP TABLE IF EXISTS note_files; DROP TABLE IF EXISTS file_context_seen; DROP TABLE IF EXISTS capture_events; DROP TABLE IF EXISTS sessions;");
    for (const c of ["kind", "session_id", "obs_type"]) raw.exec(`ALTER TABLE notes DROP COLUMN ${c}`);
    if (version === 15) {
      raw.exec("PRAGMA user_version = 15");
      return;
    }
    // v15 additions (1.6.0), removed for every older shape.
    raw.exec("DROP INDEX IF EXISTS idx_notes_superseded; DROP INDEX IF EXISTS idx_note_history_note; DROP TABLE IF EXISTS note_history; DROP TABLE IF EXISTS supersede_used; DROP TABLE IF EXISTS supersede_log;");
    for (const c of ["confidence", "confidence_by", "superseded_by", "superseded_at", "superseded_by_writer"]) raw.exec(`ALTER TABLE notes DROP COLUMN ${c}`);
    raw.exec("DELETE FROM _meta WHERE key = 'feed_key'");
    if (version === 14) {
      raw.exec("PRAGMA user_version = 14");
      return;
    }
    raw.exec("DROP TRIGGER IF EXISTS notes_log_ai; DROP TRIGGER IF EXISTS notes_log_au; DROP TRIGGER IF EXISTS notes_log_ad;");
    // v14 additions.
    raw.exec("DROP INDEX IF EXISTS idx_change_log_writer; DROP TABLE IF EXISTS trust_distrust; DROP TABLE IF EXISTS trust_attesters; DROP TABLE IF EXISTS trust_log;");
    for (const c of ["imported_created_by", "attested_writer", "attested_by", "merged_from_writers"]) raw.exec(`ALTER TABLE notes DROP COLUMN ${c}`);
    for (const c of ["note_written_by", "note_attested_writer", "note_attested_by", "note_merged_from"]) raw.exec(`ALTER TABLE change_log DROP COLUMN ${c}`);
    if (version <= 12) {
      // v13 additions.
      raw.exec("DROP INDEX IF EXISTS idx_notes_ns_writer");
      for (const c of ["written_by", "created_by", "imported_written_by"]) raw.exec(`ALTER TABLE notes DROP COLUMN ${c}`);
      raw.exec("ALTER TABLE change_log DROP COLUMN written_by");
      raw.exec("ALTER TABLE quarantine DROP COLUMN written_by");
    }
    if (version === 11) raw.exec("ALTER TABLE change_log DROP COLUMN actor");
    raw.exec(version === 13 ? V13_TRIGGERS : V11_TRIGGERS);
    raw.exec(OLD_DELETE_TRIGGER);
    raw.exec(`PRAGMA user_version = ${version}`);
  } finally {
    raw.close();
  }
}
