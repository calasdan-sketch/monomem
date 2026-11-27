// The ledger (schema v23): one hash-chained row per note change, written in the SAME transaction as the change.
//
// How: three triggers on `notes` (src/store/seal.ts) put the id of every inserted, updated or deleted note into `seal_dirty`.
// Store.commitTx() calls flushSeals() just before the outermost COMMIT: for each dirty note it verifies the state the note had
// BEFORE this transaction (so a row someone edited outside Monomem is never blessed by a later honest write), writes the new
// seal, and appends a ledger entry. Seal, ledger entry and the note change commit or roll back together, under the one write
// lock, so the chain cannot fork and a crash cannot leave a note without its entry.
//
// The chain proves order and completeness for what Monomem wrote. It is plain SHA-256 plus an Ed25519 signature per entry made
// with `.attest-key`: it catches edits by anything that cannot read that key. It does not stop a program that can.

import { hash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { signBytes, type SigningKey } from "../attest.js";
import { currentWriter } from "../actor.js";
import { StaleWriteError } from "../errors.js";
import type { Store } from "../store.js";
import { SEALED_META, bodyMacOf, macOf, metaOf, sealKeyOf, sealMessage, sealTriggerSql, type MacKey } from "./seal.js";

export const LEDGER_DOMAIN = "monomem-ledger-v1\n";
export const GENESIS_PREV = "0".repeat(64);
/** Rows sealed (and entered as `adopt`) per transaction while an upgraded store is being brought in. */
export const BACKFILL_BATCH = 2000;
/** Time the upgrade backfill may take at open before it hands the rest to a background timer. */
export const OPEN_BUDGET_MS = 250;

type Row = Record<string, unknown>;
export interface DirtyRow {
  id: number;
  op: string;
  old_seal: string | null;
  old_meta: string | null;
  rev0: number;
  arch0: number;
  bchg: number;
}
export interface LedgerEntry {
  seq: number;
  ts: string;
  op: string;
  note_id: number | null;
  rev: number | null;
  rb: number;
  namespace: string | null;
  writer: string;
  body_mac: string | null;
  seal: string | null;
  reason: string;
  prev: string;
  entry_hash: string;
  kid: string | null;
  sig: string | null;
}

/** The canonical bytes an entry hash covers. Shared with the verifier so the two cannot disagree. */
export const entryHashOf = (prev: string, e: Pick<LedgerEntry, "seq" | "ts" | "op" | "note_id" | "rev" | "rb" | "namespace" | "writer" | "body_mac" | "seal" | "reason">): string =>
  hash("sha256", prev + "\n" + JSON.stringify([e.seq, e.ts, e.op, e.note_id, e.rev, e.rb, e.namespace, e.writer, e.body_mac, e.seal, e.reason]), "hex");

/** Schema v23: additive only (a column, two tables, indexes, three triggers). Idempotent; caller holds the write lock. */
export function installSealSchema(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "seal")) db.exec("ALTER TABLE notes ADD COLUMN seal TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seal_dirty (
      id INTEGER PRIMARY KEY, op TEXT NOT NULL, old_seal TEXT, old_meta TEXT,
      rev0 INTEGER NOT NULL DEFAULT 0, arch0 INTEGER NOT NULL DEFAULT 0, bchg INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, op TEXT NOT NULL, note_id INTEGER, rev INTEGER, rb INTEGER NOT NULL DEFAULT 0,
      namespace TEXT, writer TEXT NOT NULL DEFAULT '', body_mac TEXT, seal TEXT, reason TEXT NOT NULL DEFAULT '',
      prev TEXT NOT NULL, entry_hash TEXT NOT NULL, kid TEXT, sig TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_note_rev ON ledger(note_id, rev) WHERE rb = 1;
    CREATE INDEX IF NOT EXISTS ledger_note_seq ON ledger(note_id, seq);
  `);
  for (const t of Object.values(sealTriggerSql())) db.exec(`DROP TRIGGER IF EXISTS ${t.name}; ${t.sql};`);
  const n = Number((db.prepare("SELECT COUNT(*) AS c FROM notes").get() as { c: number }).c);
  db.prepare("INSERT OR IGNORE INTO _meta(key, value) VALUES ('seal_backfill_done', ?)").run(n === 0 ? "1" : "0");
  db.prepare("INSERT OR IGNORE INTO _meta(key, value) VALUES ('seal_backfill_id', '0')").run();
}

interface Stmts {
  dirty: StatementSync;
  last: StatementSync;
  lastOf: StatementSync;
  row: StatementSync;
  setSeal: StatementSync;
  delDirty: StatementSync;
  clear: StatementSync;
  ins: StatementSync;
}
const cache = new WeakMap<DatabaseSync, Stmts>();
const warned = new WeakSet<Store>();
function stmts(db: DatabaseSync): Stmts {
  let s = cache.get(db);
  if (!s) {
    s = {
      dirty: db.prepare("SELECT id, op, old_seal, old_meta, rev0, arch0, bchg FROM seal_dirty ORDER BY id"),
      last: db.prepare("SELECT seq, entry_hash FROM ledger ORDER BY seq DESC LIMIT 1"),
      lastOf: db.prepare("SELECT body_mac FROM ledger WHERE note_id = ? AND body_mac IS NOT NULL ORDER BY seq DESC LIMIT 1"),
      row: db.prepare("SELECT * FROM notes WHERE id = ?"),
      setSeal: db.prepare("UPDATE notes SET seal = ? WHERE id = ?"),
      delDirty: db.prepare("DELETE FROM seal_dirty WHERE id = ?"),
      clear: db.prepare("DELETE FROM seal_dirty"),
      ins: db.prepare(
        "INSERT INTO ledger (seq, ts, op, note_id, rev, rb, namespace, writer, body_mac, seal, reason, prev, entry_hash, kid, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ),
    };
    cache.set(db, s);
  }
  return s;
}

/** Appends entries to the chain (caller holds the write lock). Signs each with the store's signing key when given. */
class Chain {
  private seq: number;
  private prev: string;
  constructor(private readonly s: Store, private readonly kid: string | null, private readonly sign: ((h: string) => string) | null) {
    const last = stmts(s.db).last.get() as { seq: number; entry_hash: string } | undefined;
    this.seq = last ? Number(last.seq) : 0;
    this.prev = last ? last.entry_hash : GENESIS_PREV;
  }
  add(e: { op: string; note_id: number | null; rev: number | null; rb: number; namespace: string | null; body_mac: string | null; seal: string | null; reason?: string; writer?: string }): void {
    const full = { seq: this.seq + 1, ts: new Date().toISOString(), writer: e.writer ?? currentWriter(), reason: e.reason ?? "", ...e };
    const hash = entryHashOf(this.prev, full);
    try {
      stmts(this.s.db).ins.run(full.seq, full.ts, e.op, e.note_id, e.rev, e.rb, e.namespace, full.writer, e.body_mac, e.seal, full.reason, this.prev, hash, this.kid, this.sign ? this.sign(hash) : null);
    } catch (err) {
      // UNIQUE(note_id, rev): two different writes claim one revision of one note. The transaction is rolled back by the caller.
      if (/UNIQUE constraint failed: ledger/.test((err as Error).message)) {
        throw new StaleWriteError(`note ${e.note_id}: another write already took revision ${e.rev}; nothing was changed. Re-read the note and try again.`);
      }
      throw err;
    }
    this.seq = full.seq;
    this.prev = hash;
  }
}

function newChain(s: Store): Chain {
  const sk = s.seal.signingKey();
  return new Chain(s, sk.keyId, (h) => signBytes(sk, LEDGER_DOMAIN + h));
}

/** `seal_key_id` records which signing key the seals come from; set at the first sealing. */
function ensureKeyId(s: Store, id: string): void {
  if (s.getMeta("seal_key_id") === null) {
    s.setMeta("seal_key_id", id);
    s.seal.metaChanged();
  }
}

/** Was the state this note had before the transaction a sealed state of Monomem's own? (see the file comment) */
function oldStateIsSound(s: Store, key: MacKey, d: DirtyRow, bm: string): boolean {
  if (!d.old_seal || !d.old_meta) return false;
  const last = stmts(s.db).lastOf.get(d.id) as { body_mac: string } | undefined;
  if (!last) return false;
  if (d.bchg === 0 && bm !== last.body_mac) return false; // the body was not changed by this transaction, yet it is not the sealed one
  let meta: unknown[];
  try {
    meta = JSON.parse(d.old_meta) as unknown[];
  } catch {
    return false;
  }
  return meta.length === SEALED_META.length && macOf(key, sealMessage(d.id, last.body_mac, meta)) === d.old_seal;
}

function opOf(d: DirtyRow, row: Row): { op: string; rb: number } {
  if (d.op === "c") return { op: "create", rb: 1 };
  const flipped = (row.archived_at !== null) !== (d.arch0 === 1);
  const bumped = Number(row.rev) !== d.rev0;
  return { op: flipped ? (row.archived_at !== null ? "archive" : "restore") : bumped ? "update" : "meta", rb: bumped ? 1 : 0 };
}

/** Called by Store.commitTx just before the outermost COMMIT, inside the transaction. */
export function flushSeals(s: Store): void {
  const q = stmts(s.db);
  const dirty = q.dirty.all() as unknown as DirtyRow[];
  const foreign = s.seal.foreign ?? new Set<number>();
  s.seal.foreign = null;
  if (dirty.length === 0) return;
  let k: ReturnType<typeof s.seal.key>;
  let chain: Chain;
  try {
    k = s.seal.key(true);
    if (!k) throw new Error("no key");
    ensureKeyId(s, k.id);
    chain = newChain(s);
  } catch (e) {
    // A corrupt or uncreatable .attest-key must not stop a write (it never did): the rows stay unsealed and doctor says so.
    q.clear.run();
    if (!warned.has(s)) {
      warned.add(s);
      console.error(`[monomem] notes written now are not sealed: the signing key (.attest-key) cannot be used (${(e as Error).message}). monomem check shows which.`);
    }
    return;
  }
  const backfillDone = s.getMeta("seal_backfill_done") === "1";
  for (const d of dirty) {
    q.delDirty.run(d.id);
    if (d.op === "d") {
      chain.add({ op: "delete", note_id: d.id, rev: d.rev0, rb: 0, namespace: null, body_mac: null, seal: null });
      continue;
    }
    const row = q.row.get(d.id) as Row | undefined;
    if (!row || foreign.has(d.id)) continue; // gone again, or edited outside Monomem before this write: stays unsealed
    const bm = bodyMacOf(k.key, d.id, row.body, row.body_enc);
    if (d.op === "u" && !oldStateIsSound(s, k.key, d, bm)) {
      if (!backfillDone && d.old_seal === null) continue; // a pre-upgrade row the backfill has not reached: it seals it
      continue; // not a state Monomem sealed: left unsealed so doctor names it
    }
    const seal = macOf(k.key, sealMessage(d.id, bm, metaOf(row)));
    q.setSeal.run(seal, d.id);
    const { op, rb } = opOf(d, row);
    chain.add({ op, note_id: d.id, rev: Number(row.rev), rb, namespace: String(row.namespace), body_mac: bm, seal });
  }
}

/** Sets which dirty rows predate this write (called by Store.beginWrite after the lock is taken). */
export function snapshotForeign(s: Store): void {
  const ids = stmts(s.db).dirty.all() as unknown as DirtyRow[];
  s.seal.foreign = ids.length ? new Set(ids.map((r) => r.id)) : null;
}

/** Is the upgrade backfill finished? */
export const backfillDone = (s: Store): boolean => s.getMeta("seal_backfill_done") === "1";

/**
 * One batch of the upgrade backfill: seals up to `limit` rows that have no seal yet and enters each as `adopt` ("sealed at
 * upgrade; says nothing about earlier edits"). Its own short transaction, so a 100k-note store is brought in a slice at a time
 * and a killed process resumes where it stopped (the cursor is `_meta.seal_backfill_id`).
 */
export function backfillBatch(s: Store, limit = BACKFILL_BATCH): { sealed: number; done: boolean } {
  if (backfillDone(s)) return { sealed: 0, done: true };
  s.beginWrite();
  try {
    if (backfillDone(s)) {
      s.commitTx();
      return { sealed: 0, done: true };
    }
    const q = stmts(s.db);
    const k = s.seal.key(true)!;
    ensureKeyId(s, k.id);
    const cursor = Number(s.getMeta("seal_backfill_id") ?? "0");
    const rows = s.db.prepare("SELECT * FROM notes WHERE id > ? AND seal IS NULL ORDER BY id LIMIT ?").all(cursor, limit) as Row[];
    const chain = newChain(s);
    if (cursor === 0) chain.add({ op: "adopt-start", note_id: null, rev: null, rb: 0, namespace: null, body_mac: null, seal: null, reason: "sealed at upgrade; says nothing about earlier edits" });
    for (const row of rows) {
      const id = Number(row.id);
      const bm = bodyMacOf(k.key, id, row.body, row.body_enc);
      const seal = macOf(k.key, sealMessage(id, bm, metaOf(row)));
      q.setSeal.run(seal, id);
      chain.add({ op: "adopt", note_id: id, rev: Number(row.rev), rb: 0, namespace: String(row.namespace), body_mac: bm, seal, reason: "sealed at upgrade" });
    }
    const done = rows.length < limit;
    if (rows.length) s.setMeta("seal_backfill_id", String(Number(rows[rows.length - 1].id)));
    if (done) s.setMeta("seal_backfill_done", "1");
    s.commitTx();
    s.seal.metaChanged();
    return { sealed: rows.length, done };
  } catch (e) {
    try {
      s.rollbackTx();
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}

/** Runs backfill batches until `budgetMs` is used (at open: a short slice) or the work is done. */
export function backfillFor(s: Store, budgetMs: number): boolean {
  const end = Date.now() + budgetMs;
  for (;;) {
    const r = backfillBatch(s);
    if (r.done) return true;
    if (Date.now() >= end) return false;
  }
}

/**
 * Operator command: seal every row as it is now and record that in the ledger (a `reseal` entry per row). For a changed or
 * restored key, or after the operator has looked at what doctor named and accepts it. Never run by Monomem on its own.
 */
export function resealAll(s: Store, reason: string): number {
  installSealSchema(s.db);
  let n = 0;
  for (;;) {
    s.beginWrite();
    try {
      const k = s.seal.key(true)!;
      s.setMeta("seal_key_id", k.id);
      const cursor = Number(s.getMeta("reseal_cursor") ?? "0");
      const rows = s.db.prepare("SELECT * FROM notes WHERE id > ? ORDER BY id LIMIT ?").all(cursor, BACKFILL_BATCH) as Row[];
      const chain = newChain(s);
      const q = stmts(s.db);
      for (const row of rows) {
        const id = Number(row.id);
        const bm = bodyMacOf(k.key, id, row.body, row.body_enc);
        const seal = macOf(k.key, sealMessage(id, bm, metaOf(row)));
        q.setSeal.run(seal, id);
        chain.add({ op: "reseal", note_id: id, rev: Number(row.rev), rb: 0, namespace: String(row.namespace), body_mac: bm, seal, reason });
        s.db.prepare("DELETE FROM seal_dirty WHERE id = ?").run(id);
      }
      const last = rows.length ? Number(rows[rows.length - 1].id) : cursor;
      const done = rows.length < BACKFILL_BATCH;
      s.setMeta("reseal_cursor", done ? "0" : String(last));
      if (done) s.setMeta("seal_backfill_done", "1");
      s.commitTx();
      s.seal.metaChanged();
      n += rows.length;
      if (done) return n;
    } catch (e) {
      try {
        s.rollbackTx();
      } catch {
        /* already rolled back */
      }
      throw e;
    }
  }
}

/** Runs at open: a slice of the upgrade backfill now, the rest in the background of a long-lived process (never blocks startup for long). */
export function backfillAtOpen(s: Store): void {
  try {
    if (backfillDone(s) || backfillFor(s, OPEN_BUDGET_MS)) return;
  } catch {
    return; // a busy or read-only file: the next open continues from the cursor
  }
  const tick = (): void => {
    try {
      if (backfillBatch(s).done) return;
    } catch {
      return;
    }
    setTimeout(tick, 25).unref();
  };
  setTimeout(tick, 25).unref();
}

/** After a key rotation: seals that verify under the old key are re-made under the new one. Rows that did not verify stay as they were. */
export function rekeyAfterRotation(s: Store, old: SigningKey): number {
  const oldKey = sealKeyOf(old);
  s.seal.reset();
  let moved = 0;
  try {
    for (let cursor = 0; ; ) {
      s.beginWrite();
      try {
        const k = s.seal.key(true)!;
        const chain = newChain(s);
        const q = stmts(s.db);
        const rows = s.db.prepare("SELECT * FROM notes WHERE id > ? AND seal IS NOT NULL ORDER BY id LIMIT ?").all(cursor, BACKFILL_BATCH) as Row[];
        for (const row of rows) {
          const id = Number(row.id);
          if (macOf(oldKey, sealMessage(id, bodyMacOf(oldKey, id, row.body, row.body_enc), metaOf(row))) !== row.seal) continue;
          const bm = bodyMacOf(k.key, id, row.body, row.body_enc);
          const seal = macOf(k.key, sealMessage(id, bm, metaOf(row)));
          q.setSeal.run(seal, id);
          chain.add({ op: "reseal", note_id: id, rev: Number(row.rev), rb: 0, namespace: String(row.namespace), body_mac: bm, seal, reason: "signing key rotated" });
          moved++;
        }
        cursor = rows.length ? Number(rows[rows.length - 1].id) : cursor;
        if (rows.length < BACKFILL_BATCH) s.setMeta("seal_key_id", k.id);
        s.commitTx();
        s.seal.metaChanged();
        if (rows.length < BACKFILL_BATCH) return moved;
      } catch (e) {
        try {
          s.rollbackTx();
        } catch {
          /* already rolled back */
        }
        throw e;
      }
    }
  } catch (e) {
    console.error(`[monomem] the signing key was rotated, but the note seals could not be moved to it (${(e as Error).message}); run: monomem integrity reseal`);
    return moved;
  }
}
