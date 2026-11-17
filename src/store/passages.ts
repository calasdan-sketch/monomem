// Passage pooling (PLAN D/I, opt-in): long notes are also indexed as overlapping passages, and a note's passage score is
// its best passage's bm25. search-service fuses that ranking with the whole-note ranking (RRF). Off by default:
// `monomem settings set passage_pooling on`. With it off nothing here runs and search is unchanged.
//
// Storage: one side table, created only when switched on (CREATE ... IF NOT EXISTS; no schema version bump, older binaries
// ignore it). Contentless FTS5 (`content=''`): the inverted index only, no second copy of the text. Rowid = note id * SLOT
// + passage number, so a passage maps back to its note with no extra table. Not on encrypted stores: an on-disk index of
// sealed bodies would put their words on disk, so pooling is skipped there and search stays whole-note.
//
// Kept current lazily, like the encrypted body index (body-index.ts): before a pooled search, the change_log rows after the
// last seen seq are replayed (that note's passages deleted and re-cut); a trimmed log or a missing table means a full build.
// Inside a caller's transaction nothing is written, so the index is used only when it already holds every change. A failed
// sync means the index is not searched either (whole notes only): a stale passage index is never used.
//
// Node 26: a DELETE from a contentless_delete FTS5 table leaves the connection's last insert rowid above 2^53, and
// node:sqlite reads it after every run() (Node 26 throws, Node 24 returns a wrong number; then every later run() on the
// connection does the same). So passages are only ever deleted inside a TEMP trigger (on a TEMP view, this connection
// only): SQLite puts the last rowid back when a trigger ends.

import type { Store } from "../store.js";
import { extractKeywords, searchStem } from "../keywords.js";

export const PASSAGE_SETTING = "passage_pooling";
const SEQ_KEY = "passages_seq";
const TABLE = "passages_fts";
/** Passages per note at most (rowid space per note). A 256 KB body cut as below gives about 430. */
const SLOT = 4096;
/** A line longer than this is cut into pieces of about this size (at a space when one is near). */
export const PASSAGE_CHARS = 600;
/** Lines per passage and step: 3 turns, stride 2 (brainstorm-retrieval.md #3: stride 2 scored as stride 1, half the size). */
const WINDOW = 3;
const STRIDE = 2;
const BUILD_BATCH = 1000;
/** Passage rows read per wanted note (the best passages by bm25, before weighing). */
const PASSAGES_PER_NOTE = 8;

/** Whether pooled search should run for this store: switched on and not encrypted. */
export function passagePoolingOn(store: Store): boolean {
  return store.getMeta(PASSAGE_SETTING) === "on" && !store.sealsWrites();
}

/** The body cut into passages: lines (long lines cut to about PASSAGE_CHARS), WINDOW lines per passage, every STRIDE lines. */
export function passagesOf(body: string): string[] {
  const units: string[] = [];
  for (const line of body.split("\n")) {
    let rest = line.trim();
    while (rest.length > PASSAGE_CHARS) {
      const sp = rest.lastIndexOf(" ", PASSAGE_CHARS);
      const at = sp > PASSAGE_CHARS / 2 ? sp : PASSAGE_CHARS;
      units.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    if (rest) units.push(rest);
  }
  if (units.length <= WINDOW) return units.length ? [units.join("\n")] : [];
  const out: string[] = [];
  for (let i = 0; i < units.length && out.length < SLOT; i += STRIDE) {
    out.push(units.slice(i, i + WINDOW).join("\n"));
    if (i + WINDOW >= units.length) break;
  }
  return out;
}

/** One write transaction without announcing a note change (only the side table and its mark change). */
function inTx(store: Store, fn: () => void): void {
  store.beginWrite();
  try {
    fn();
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
}

/** The TEMP view whose INSTEAD OF trigger deletes a note's passages (see the Node 26 note at the top). */
const DEL_VIEW = "om_passages_del";

/** Create the delete view and trigger on this connection if missing. TEMP: never seen by other connections or binaries. */
function ensureDeleteView(store: Store): void {
  store.db.exec(`CREATE TEMP VIEW IF NOT EXISTS ${DEL_VIEW}(lo, hi) AS SELECT 0, 0;
    CREATE TEMP TRIGGER IF NOT EXISTS ${DEL_VIEW}_t INSTEAD OF INSERT ON ${DEL_VIEW}
    BEGIN DELETE FROM main.${TABLE} WHERE rowid >= new.lo AND rowid < new.hi; END;`);
}

function tableExists(store: Store): boolean {
  return store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE) !== undefined;
}

function indexNote(store: Store, ins: { run: (...a: Array<number | string>) => unknown }, id: number, body: string): void {
  passagesOf(body).forEach((p, k) => ins.run(id * SLOT + k, p));
}

/** Drop and rebuild every passage. Caller holds a write transaction. */
function build(store: Store): void {
  const db = store.db;
  db.exec(`DROP TABLE IF EXISTS ${TABLE};
    CREATE VIRTUAL TABLE ${TABLE} USING fts5(body, content='', contentless_delete=1, prefix='1');`);
  store.setMeta(SEQ_KEY, String(store.maxChangeSeq()));
  const ins = db.prepare(`INSERT INTO ${TABLE}(rowid, body) VALUES (?, ?)`);
  const rows = db.prepare("SELECT id, body FROM notes WHERE id > ? AND id <= ? AND body_enc IS NULL");
  const top = Number((db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM notes").get() as { m: number }).m);
  for (let a = 0; a < top; a += BUILD_BATCH) {
    for (const r of rows.all(a, a + BUILD_BATCH) as Array<{ id: number; body: string }>) indexNote(store, ins, Number(r.id), r.body ?? "");
  }
}

/**
 * Bring the passage index up to date. Returns false when there is no current index to search (inside a caller's
 * transaction with changes not yet replayed, or the sync failed; the caller then searches whole notes only).
 */
export function syncPassages(store: Store): boolean {
  const db = store.db;
  const exists = tableExists(store);
  const seen = Number(store.getMeta(SEQ_KEY) ?? NaN);
  // Inside a caller's transaction nothing is written: the index is searched only when it already holds every change.
  if (db.isTransaction) return exists && Number.isFinite(seen) && store.maxChangeSeq() === seen;
  try {
    const rows = exists && Number.isFinite(seen)
      ? (db.prepare("SELECT seq, note_id FROM change_log WHERE seq > ? ORDER BY seq").all(seen) as Array<{ seq: number; note_id: number }>)
      : null;
    // Nothing new: no write at all (a search must not take the write lock for nothing).
    if (rows && rows.length === 0 && store.maxChangeSeq() >= seen) return true;
    // The log was trimmed past our point (purge), or no index yet: rebuild.
    const full = !rows || Number(rows[0]?.seq) !== seen + 1;
    inTx(store, () => {
      if (full) return build(store);
      ensureDeleteView(store);
      const del = db.prepare(`INSERT INTO ${DEL_VIEW}(lo, hi) VALUES (?, ?)`);
      const get = db.prepare("SELECT body FROM notes WHERE id = ? AND body_enc IS NULL");
      const ins = db.prepare(`INSERT INTO ${TABLE}(rowid, body) VALUES (?, ?)`);
      for (const id of new Set(rows.map((r) => Number(r.note_id)))) {
        del.run(id * SLOT, (id + 1) * SLOT);
        const n = get.get(id) as { body: string } | undefined;
        if (n) indexNote(store, ins, id, n.body ?? "");
      }
      store.setMeta(SEQ_KEY, String(rows[rows.length - 1].seq));
    });
    return true;
  } catch (e) {
    process.stderr.write(`monomem: passage index not updated (${(e as Error).message}); searching whole notes\n`);
    return false;
  }
}

/** Remove the passage index and its mark (switching pooling off). The file keeps its size until a VACUUM. */
export function dropPassages(store: Store): void {
  inTx(store, () => {
    store.db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    store.db.prepare("DELETE FROM _meta WHERE key = ?").run(SEQ_KEY);
  });
}

/** Passages in the index (0 when there is none). */
export function passageCount(store: Store): number {
  if (!tableExists(store)) return 0;
  return Number((store.db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number }).c);
}

/**
 * Notes ranked by their best passage for the query's keywords (any keyword, suffix-trimmed stems as the any-keyword search
 * uses). Same visibility filters as Store.searchRanked: live notes, namespace, range, writer, distrust.
 */
export function passageHits(
  store: Store,
  query: string,
  limit: number,
  opts: Parameters<Store["searchRanked"]>[1] = {},
  /** Multiplier for one passage's bm25 from its text (search-service passes the rarity-weighted keyword coverage). */
  weigh: (text: string) => number = () => 1
): Array<{ note: ReturnType<Store["rec"]>; score: number }> {
  const stems = [...new Set(extractKeywords(query).map((k) => searchStem(k.replace(/^#/, ""))))].filter((k) => /[\p{L}\p{N}]/u.test(k));
  if (stems.length === 0 || !syncPassages(store)) return [];
  const match = stems.map((t) => `"${t.replace(/"/g, '""')}"${/^\p{L}{1,2}$/u.test(t) ? "" : "*"}`).join(" OR ");
  const range = store.rangeFor(opts ?? {}, opts?.namespace ? [opts.namespace] : undefined);
  const live = opts?.includeSuperseded ? "(notes.archived_at IS NULL OR notes.superseded_by IS NOT NULL)" : "notes.archived_at IS NULL";
  try {
    // The best passages by bm25 (PASSAGE_ROWS of them), each note once with its record; then weigh and pool per note.
    const rows = store.db
      .prepare(
        // MATERIALIZED: a flattened subquery would call bm25() outside its MATCH context.
        `WITH hit AS MATERIALIZED (SELECT rowid AS r, -bm25(${TABLE}) AS s FROM ${TABLE} WHERE ${TABLE} MATCH ?)
         SELECT hit.r AS p_rowid, hit.s AS p_score, notes.* FROM hit
         JOIN notes ON notes.id = hit.r / ${SLOT}
         WHERE ${live}${opts?.namespace ? " AND notes.namespace = ?" : ""}${range.sql}
         ORDER BY hit.s DESC, notes.updated_at DESC, notes.id DESC
         LIMIT ?`
      )
      .all(match, ...(opts?.namespace ? [opts.namespace] : []), ...range.params, limit * PASSAGES_PER_NOTE) as unknown as Array<
      Parameters<Store["rec"]>[0] & { p_rowid: number; p_score: number }
    >;
    const best = new Map<number, { note: ReturnType<Store["rec"]>; score: number; parts: string[] }>();
    for (const r of rows) {
      const id = Number(r.id);
      let b = best.get(id);
      if (!b) {
        const note = store.rec(r);
        b = { note, score: -Infinity, parts: passagesOf(note.body) };
        best.set(id, b);
      }
      const sc = Number(r.p_score) * weigh(b.parts[Number(r.p_rowid) % SLOT] ?? "");
      if (sc > b.score) b.score = sc;
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ note, score }) => ({ note, score }));
  } catch (e) {
    if (/fts5|syntax error|unterminated|no such/i.test((e as Error).message)) return [];
    throw e;
  }
}
