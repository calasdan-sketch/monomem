// C-04 (1.5.0): `monomem encrypt status --surfaces`. Every place note content can exist, and whether it is encrypted on
// this store right now, from counts (never the text itself). The wording is kept in step with the table in
// docs/encryption-retention.md: a test fails when a surface listed here is not named there.
// Free function over the Store; Store keeps a one-line delegate. Imports `type { Store }` only.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store.js";
import { SPOOL_FILE } from "../capture.js";

export interface EncryptionSurface {
  surface: string;
  /** yes / partly / no (counts say), nothing stored, no note text (by design), not checked (outside this database). */
  encrypted: "yes" | "partly" | "no" | "nothing stored" | "no note text" | "not checked" | "not on disk";
  sealed?: number;
  plain?: number;
  detail: string;
}

const verdict = (sealed: number, plain: number): EncryptionSurface["encrypted"] =>
  sealed + plain === 0 ? "nothing stored" : plain === 0 ? "yes" : sealed === 0 ? "no" : "partly";

/** A surface that can be sealed: its counts decide the verdict. */
const counted = (surface: string, sealed: number, plain: number, detail: string): EncryptionSurface => ({ surface, encrypted: verdict(sealed, plain), sealed, plain, detail });
/** A surface that is never sealed: "no" when it holds anything. */
const never = (surface: string, plain: number, detail: string): EncryptionSurface => ({ surface, encrypted: plain ? "no" : "nothing stored", plain, detail });

/** Lines of the capture spool: [sealed, plain]. Sealed lines carry a `sealed` envelope (S-02b). */
function spoolCounts(dataDir: string): [number, number] {
  const p = join(dataDir, SPOOL_FILE);
  if (!existsSync(p)) return [0, 0];
  let sealed = 0;
  let plain = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      if (typeof (JSON.parse(line) as { sealed?: unknown }).sealed === "string") sealed++;
      else plain++;
    } catch {
      plain++; // an unreadable line is not known to be sealed
    }
  }
  return [sealed, plain];
}

/** Conflict folders kept by sync --git (each holds plain Markdown). */
function conflicts(dataDir: string): number {
  try {
    return readdirSync(join(dataDir, "sync-conflicts")).length;
  } catch {
    return 0;
  }
}

export function encryptionSurfaces(s: Store, o: { dataDir: string; dbPath: string }): EncryptionSurface[] {
  const n = (sql: string): number => Number((s.db.prepare(sql).get() as { c: number }).c);
  const key = s.sealsWrites();
  const notes = n("SELECT COUNT(*) AS c FROM notes");
  const plainBodies = s.plaintextBodyCount();
  const [spoolSealed, spoolPlain] = spoolCounts(o.dataDir);
  // A captured note made with a key has a fixed title ("Decision (sealed)", "Session 2026-11-14") and no obs.concept tags.
  const capturedWords = n(
    "SELECT COUNT(*) AS c FROM notes WHERE kind IN ('observation','summary') AND NOT ((title LIKE '% (sealed)' OR title GLOB 'Session [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]') AND tags NOT LIKE '%obs.concept:%')"
  );
  const capturedFixed = n("SELECT COUNT(*) AS c FROM notes WHERE kind IN ('observation','summary')") - capturedWords;
  const copies = (s.constructor as typeof Store).preMigrationBackups(o.dbPath).length;
  // ponytail: an access-log preview is counted as sealed by its envelope prefix; a plain preview that happens to start "v2:" counts as sealed.
  const accessSealed = n("SELECT COUNT(*) AS c FROM access_log WHERE query <> '' AND (query LIKE 'v1:%' OR query LIKE 'v2:%')");
  return [
    counted("note bodies", s.encryptedCount(), plainBodies, key ? (plainBodies ? "some bodies were written before the key: monomem encrypt enable seals them" : "sealed with the key beside the database") : "no key: monomem encrypt enable"),
    never("note titles", notes, "never encrypted: search, listings and namespaces read them"),
    never("tags", n("SELECT COUNT(*) AS c FROM notes WHERE tags <> ''"), "never encrypted (facts are tags too)"),
    never("sources", n("SELECT COUNT(*) AS c FROM notes WHERE source <> ''") + n("SELECT COUNT(*) AS c FROM confirmations WHERE source <> ''"), "a note's claimed source and confirm sources: never encrypted"),
    counted("old versions", n("SELECT COUNT(*) AS c FROM note_history WHERE body_enc IS NOT NULL"), n("SELECT COUNT(*) AS c FROM note_history WHERE body_enc IS NULL AND body <> ''"), "bodies of kept versions; their titles and tags stay plain"),
    counted("held writes", n("SELECT COUNT(*) AS c FROM quarantine WHERE sealed = 1"), n("SELECT COUNT(*) AS c FROM quarantine WHERE sealed = 0"), "title, body and tags of writes waiting for review"),
    counted(
      "captured prompts and tool output",
      n("SELECT COUNT(*) AS c FROM capture_events WHERE input_enc IS NOT NULL OR output_enc IS NOT NULL"),
      n("SELECT COUNT(*) AS c FROM capture_events WHERE (input_enc IS NULL AND input <> '') OR (output_enc IS NULL AND output <> '')"),
      "raw capture events (kept 7 days); tool names and times stay plain"
    ),
    counted("capture spool", spoolSealed, spoolPlain, `${SPOOL_FILE} lines waiting to be stored; plain lines are from before the key or before 1.5.0`),
    counted("captured titles and tags", capturedFixed, capturedWords, key ? "sealed here = a fixed title and no word tags; older captured notes keep their words" : "no key: captured titles and tags use the words of the session"),
    never("captured file paths and folders", n("SELECT COUNT(*) AS c FROM note_files") + n("SELECT COUNT(*) AS c FROM sessions WHERE cwd <> ''"), "never encrypted: a secret in a file or folder name stays readable"),
    never("code anchors", n("SELECT COUNT(*) AS c FROM code_anchors"), "files a note was written about (memory_save files): repository path, file path and git ids, never encrypted"),
    // 1.6 (PLAN D): memory_save evidence (store/evidence.ts); its side table exists only once a note was saved with evidence.
    ...(s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_evidence'").get()
      ? [counted("observed evidence", n("SELECT COUNT(*) AS c FROM note_evidence WHERE items LIKE 'v3:%'"), n("SELECT COUNT(*) AS c FROM note_evidence WHERE items NOT LIKE 'v3:%'"), "what a writer said it observed (memory_save evidence): sealed when saved with a key")]
      : []),
    never("search index", notes, plainBodies ? `every title and tag, and the bodies of the ${plainBodies} plain notes; sealed bodies are not indexed on disk` : "every title and tag; sealed bodies are not indexed on disk"),
    {
      surface: "body search index",
      encrypted: "not on disk",
      detail: key
        ? `held in memory by each Monomem process that searches while encryption is on (servers build it at start, the hooks never do): every body's words, decrypted. Monomem never writes it to disk, but the OS can page it to swap or a hibernation file and a crash dump can contain it; MONOMEM_BODY_INDEX=off turns it off (in this process: ${s.bodyIndexInfo().state})`
        : "not used without a key: search reads the on-disk index (swap and crash-dump caveat applies only with a key; MONOMEM_BODY_INDEX=off turns it off)",
    },
    never("change feed log", n("SELECT COUNT(*) AS c FROM change_log"), "titles of recent changes, kept for the change feed"),
    never("embeddings", n("SELECT COUNT(*) AS c FROM note_vectors"), "vectors are never encrypted; with embeddings on, the decrypted body is sent to your embeddings endpoint"),
    counted("access log", accessSealed, n("SELECT COUNT(*) AS c FROM access_log WHERE query <> ''") - accessSealed, "the redacted 120-character preview of what was asked"),
    { surface: "audit log", encrypted: "no note text", detail: "audit.log holds operations, ids, namespaces and byte counts, never note text" },
    { surface: "server log", encrypted: "no note text", detail: "server.log (start --log) holds paths, ports and errors; Monomem writes no note text there" },
    { surface: "backups", encrypted: "not checked", ...(copies ? { plain: copies } : {}), detail: `a backup is the database as it was then, sealed or not${copies ? `; ${copies} pre-upgrade cop${copies === 1 ? "y" : "ies"} may hold bodies from before the key` : ""}; the key is only in it with --include-key` },
    never("sync conflicts", conflicts(o.dataDir), "sync-conflicts/<time>/ in the data folder: the losing side of a sync --git edit conflict, written decrypted"),
    { surface: "project rules files", encrypted: "no", detail: "monomem project-rules copies the decrypted bodies of confirmed notes into the repository's AGENTS.md / CLAUDE.md, which is usually committed" },
    { surface: "exports", encrypted: "no", detail: "monomem export (JSON or a Markdown folder) and GET /export write decrypted bodies: store them accordingly" },
    { surface: "sync files", encrypted: "not checked", detail: "monomem sync --git --encrypt seals every file; without --encrypt the repository holds plain Markdown" },
  ];
}
