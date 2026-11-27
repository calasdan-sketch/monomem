// What doctor, `audit verify` and `monomem verify-lossless` check about seals and the ledger (read-only; never changes a row).
//
// "Lossless" as invariants (README and docs/lossless.md quote this text; test/lossless-invariants.test.ts runs it):
//   L1  Ack implies ledger: every write Monomem acknowledged (note id + rev) has a content-changing ledger entry.
//   L2  One body per rev: a (note id, rev) pair has exactly one ledger entry (a database constraint), and where that version is
//       still stored (the live row or note_history) its text matches the entry's keyed body digest.
//   L3  Monotone revs: the revs of a note's content-changing entries only go up, with no repeat.
//   L4  Nothing vanishes silently: every note the ledger saw is live, archived or has a `delete` entry.
//   L5  Round trip: export then import into an empty store keeps every title, body and tag (test-only, needs two stores).
//   L6  History drops are explicit: a stored earlier version always has a ledger entry; versions pruned by the history limit are
//       counted in note_history_dropped. A version with neither was removed outside Monomem.
// Exceptions that are by design: NUL bytes and lone UTF-16 surrogates are stored as U+FFFD; versions beyond the history limit are
// dropped (counted); notes that existed before the v23 upgrade have no history in the ledger (they enter as `adopt`).

import type { Store } from "../store.js";
import { createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";
import { GENESIS_PREV, LEDGER_DOMAIN, entryHashOf, type LedgerEntry } from "./ledger.js";
import { sealTriggerSql, statusOf, bodyMacOf } from "./seal.js";

type Row = Record<string, unknown>;
export interface IntegrityIssue {
  /** Short code, stable for scripts. */
  code: string;
  /** One plain sentence. */
  message: string;
  ids?: number[];
  /** Counts as a failure (a warning otherwise). */
  severity: "fail" | "warn";
}
export interface IntegrityReport {
  notes: number;
  sealed: number;
  ledgerEntries: number;
  backfillDone: boolean;
  backfillRemaining: number;
  issues: IntegrityIssue[];
  /** Invariants checked and found fine, by name (L2, L3, ...). */
  held: string[];
  ms: number;
}

const BATCH = 5000;
const MAX_IDS = 50;
const issue = (code: string, message: string, severity: "fail" | "warn", ids?: number[]): IntegrityIssue => ({ code, message, severity, ...(ids?.length ? { ids: ids.slice(0, MAX_IDS) } : {}) });
const count = (s: Store, sql: string, ...p: Array<string | number>): number => Number((s.db.prepare(sql).get(...p) as { c: number }).c);

/** Seals: which rows fail. Reads every row once, in id batches. */
export function scanSeals(s: Store): { total: number; ok: number; unsealed: number[]; mismatch: number[]; legacy: number } {
  const out = { total: 0, ok: 0, unsealed: [] as number[], mismatch: [] as number[], legacy: 0 };
  const stmt = s.db.prepare("SELECT * FROM notes WHERE id > ? ORDER BY id LIMIT ?");
  for (let cursor = 0; ; ) {
    const rows = stmt.all(cursor, BATCH) as Row[];
    if (!rows.length) break;
    for (const r of rows) {
      out.total++;
      const st = statusOf(s.seal, r);
      if (st === "ok") out.ok++;
      else if (st === "mismatch") out.mismatch.push(Number(r.id));
      else if (st === "unsealed") out.unsealed.push(Number(r.id));
      else if (r.seal === null) out.legacy++;
      else out.ok++; // present but not checkable (key changed): reported separately
    }
    cursor = Number(rows[rows.length - 1].id);
  }
  return out;
}

function publicKeyOf(cache: Map<string, KeyObject | null>, raw: Map<string, string>, kid: string): KeyObject | undefined {
  if (!cache.has(kid)) {
    const x = raw.get(kid);
    try {
      cache.set(kid, x ? createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }) : null);
    } catch {
      cache.set(kid, null);
    }
  }
  return cache.get(kid) ?? undefined;
}
const sigOk = (pub: KeyObject, entryHash: string, sig: string): boolean => {
  try {
    return edVerify(null, Buffer.from(LEDGER_DOMAIN + entryHash), pub, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
};

/** The chain: contiguous seq, linked hashes, recomputed hashes, and (with `signatures`) the Ed25519 signature of each entry. */
export function verifyChain(s: Store, signatures: boolean): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const raw = new Map<string, string>();
  const keys = new Map<string, KeyObject | null>();
  const cur = s.peekIdentity();
  if (cur.key_id && cur.public_key) raw.set(cur.key_id, cur.public_key);
  try {
    for (const r of s.db.prepare("SELECT key_id, public_key FROM trust_attesters").all() as Array<{ key_id: string; public_key: string }>) raw.set(r.key_id, raw.get(r.key_id) ?? r.public_key);
  } catch {
    /* no trust table: only the current key */
  }
  const stmt = s.db.prepare("SELECT * FROM ledger WHERE seq > ? ORDER BY seq LIMIT ?");
  let prevHash = GENESIS_PREV;
  let prevSeq = 0;
  let unchecked = 0;
  for (let cursor = 0; ; ) {
    const rows = stmt.all(cursor, BATCH) as unknown as LedgerEntry[];
    if (!rows.length) break;
    for (const e of rows) {
      if (e.seq !== prevSeq + 1) issues.push(issue("ledger-gap", `ledger entry ${e.seq} follows ${prevSeq}: ${e.seq > prevSeq + 1 ? "entries are missing" : "out of order"}`, "fail"));
      if (e.prev !== prevHash) issues.push(issue("ledger-link", `ledger entry ${e.seq} does not link to the entry before it (removed, inserted or edited)`, "fail"));
      if (entryHashOf(e.prev, e) !== e.entry_hash) issues.push(issue("ledger-hash", `ledger entry ${e.seq} was edited (its hash does not match its contents)`, "fail"));
      if (signatures) {
        const pub = e.kid ? publicKeyOf(keys, raw, e.kid) : undefined;
        if (!e.sig || !e.kid) issues.push(issue("ledger-unsigned", `ledger entry ${e.seq} has no signature`, "warn"));
        else if (!pub) unchecked++;
        else if (!sigOk(pub, e.entry_hash, e.sig)) issues.push(issue("ledger-signature", `ledger entry ${e.seq} has a bad signature`, "fail"));
      }
      prevHash = e.entry_hash;
      prevSeq = e.seq;
    }
    cursor = prevSeq;
  }
  if (unchecked) issues.push(issue("ledger-key-unknown", `${unchecked} ledger entries were signed by a key this store does not list; their signatures were not checked`, "warn"));
  return issues;
}

/** Ledger against the notes table: rows nobody wrote, rows deleted outside Monomem, rows reverted or edited. */
export function reconcile(s: Store): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const ids = (sql: string): number[] => (s.db.prepare(sql).all() as Array<{ id: number }>).map((r) => Number(r.id));
  const noEntry = !s.seal.state().backfillDone ? [] : ids("SELECT n.id AS id FROM notes n WHERE NOT EXISTS (SELECT 1 FROM ledger e WHERE e.note_id = n.id) ORDER BY n.id");
  if (noEntry.length) issues.push(issue("row-without-ledger", `${noEntry.length} note(s) have no ledger entry (inserted outside Monomem)`, "fail", noEntry));
  const gone = ids(
    `SELECT e.note_id AS id FROM ledger e WHERE e.seq = (SELECT MAX(seq) FROM ledger WHERE note_id = e.note_id) AND e.op <> 'delete'
       AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = e.note_id) ORDER BY e.note_id`
  );
  if (gone.length) issues.push(issue("row-deleted-outside", `${gone.length} note(s) the ledger recorded are gone with no delete entry (deleted outside Monomem)`, "fail", gone));
  const drift = ids(
    `SELECT n.id AS id FROM notes n JOIN ledger e ON e.seq = (SELECT MAX(seq) FROM ledger WHERE note_id = n.id AND seal IS NOT NULL)
       WHERE n.seal IS NOT NULL AND e.seal IS NOT n.seal ORDER BY n.id`
  );
  if (drift.length) issues.push(issue("row-differs-from-ledger", `${drift.length} note(s) differ from the last state the ledger recorded (edited or reverted outside Monomem)`, "fail", drift));
  return issues;
}

/** The cheap invariants L2, L3, L4 and L6 (see the top of this file). */
export function invariants(s: Store): { issues: IntegrityIssue[]; held: string[] } {
  const issues: IntegrityIssue[] = [];
  const held: string[] = [];
  const dup = (s.db.prepare("SELECT note_id AS id FROM ledger WHERE rb = 1 GROUP BY note_id, rev HAVING COUNT(*) > 1").all() as Array<{ id: number }>).map((r) => Number(r.id));
  if (dup.length) issues.push(issue("L2", "two ledger entries claim the same revision of a note", "fail", dup));
  else held.push("L2");
  const back = (
    s.db
      .prepare(
        `SELECT DISTINCT note_id AS id FROM (SELECT note_id, rev, LAG(rev) OVER (PARTITION BY note_id ORDER BY seq) AS p FROM ledger WHERE rb = 1)
         WHERE p IS NOT NULL AND rev <= p`
      )
      .all() as Array<{ id: number }>
  ).map((r) => Number(r.id));
  if (back.length) issues.push(issue("L3", "a note's revision went backwards or repeated in the ledger", "fail", back));
  else held.push("L3");
  // L4 is the reconcile() check "row-deleted-outside"; reported there. Listed as held when that check is clean (see verifyAll).
  const hist = (
    s.db
      .prepare(
        `SELECT DISTINCT h.note_id AS id FROM note_history h
          WHERE h.version > COALESCE((SELECT MAX(rev) FROM ledger WHERE note_id = h.note_id AND op IN ('adopt', 'reseal')), 0)
            AND NOT EXISTS (SELECT 1 FROM ledger e WHERE e.note_id = h.note_id AND e.rev = h.version AND e.rb = 1)`
      )
      .all() as Array<{ id: number }>
  ).map((r) => Number(r.id));
  if (hist.length) issues.push(issue("L6", "a stored earlier version has no ledger entry (planted or kept from outside Monomem)", "fail", hist));
  else held.push("L6");
  return { issues, held };
}

/** L2 for text: the stored earlier versions of plain (unencrypted) notes match the keyed digest in the ledger. */
export function historyBodies(s: Store): IntegrityIssue[] {
  const k = s.seal.key(false);
  if (!k) return [];
  // Only entries made under the current key: after a rotation the older digests cannot be re-made (the old key is gone), so they are not compared.
  const bad: number[] = [];
  const rows = s.db
    .prepare(
      `SELECT h.note_id AS id, h.body AS body, e.body_mac AS mac FROM note_history h JOIN ledger e ON e.note_id = h.note_id AND e.rev = h.version AND e.rb = 1
        WHERE h.body_enc IS NULL AND e.kid = ?`
    )
    .all(k.id) as Array<{ id: number; body: string; mac: string | null }>;
  for (const r of rows) if (r.mac && r.mac !== bodyMacOf(k.key, Number(r.id), r.body, null)) bad.push(Number(r.id));
  return bad.length ? [issue("L2-history", "a stored earlier version's text does not match what the ledger recorded for that revision", "fail", [...new Set(bad)])] : [];
}

/** Are the three seal triggers present and exactly as this build creates them? (An attacker who drops one can edit without a trace in `seal_dirty`.) */
export function triggersIntact(s: Store): IntegrityIssue[] {
  const out: IntegrityIssue[] = [];
  for (const t of Object.values(sealTriggerSql())) {
    const r = s.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t.name) as { sql: string } | undefined;
    if (!r) out.push(issue("trigger-missing", `the seal trigger ${t.name} is missing (note edits are not being sealed)`, "fail"));
    else if (r.sql.replace(/\s+/g, " ") !== t.sql.replace(/\s+/g, " ")) out.push(issue("trigger-changed", `the seal trigger ${t.name} was changed`, "fail"));
  }
  return out;
}

/** Everything, for doctor (`fast`: chain and seals, no signature checks) and `verify-lossless`. Read-only. */
export function verifyAll(s: Store, opts: { signatures?: boolean } = {}): IntegrityReport {
  const t0 = Date.now();
  const issues: IntegrityIssue[] = [];
  const seals = scanSeals(s);
  const k = s.seal.key(false);
  const st = s.seal.state();
  if (!k) issues.push(issue("no-key", "there is no signing key (.attest-key) to check the seals with", "warn"));
  else if (st.keyId && st.keyId !== k.id) {
    issues.push(issue("key-changed", `the seals were made under key ${st.keyId} but the current key is ${k.id} (a restore without the key file, or a rotation that did not finish)`, "fail"));
  }
  if (seals.mismatch.length) issues.push(issue("seal-mismatch", `${seals.mismatch.length} note(s) were changed outside Monomem (their seal does not match)`, "fail", seals.mismatch));
  if (seals.unsealed.length) issues.push(issue("seal-missing", `${seals.unsealed.length} note(s) have no seal (written or edited outside Monomem)`, "fail", seals.unsealed));
  const done = st.backfillDone;
  const remaining = done ? 0 : seals.legacy;
  if (!done) issues.push(issue("backfill", `sealing the notes that existed before the upgrade is ${seals.total ? Math.round(((seals.total - remaining) / seals.total) * 100) : 100}% done; run monomem integrity seal to finish it now`, "warn"));
  issues.push(...triggersIntact(s), ...verifyChain(s, opts.signatures === true), ...reconcile(s));
  const inv = invariants(s);
  issues.push(...inv.issues, ...historyBodies(s));
  const held = [...inv.held];
  if (!issues.some((i) => i.code === "row-deleted-outside")) held.push("L4");
  return {
    notes: seals.total,
    sealed: seals.ok,
    ledgerEntries: count(s, "SELECT COUNT(*) AS c FROM ledger"),
    backfillDone: done,
    backfillRemaining: remaining,
    issues,
    held: held.sort(),
    ms: Date.now() - t0,
  };
}

/** L1: acknowledged writes `(id, rev)` that have no content-changing ledger entry (a write Monomem said yes to and did not record). */
export function missingAcks(s: Store, acks: Array<{ id: number; rev: number }>): Array<{ id: number; rev: number }> {
  const q = s.db.prepare("SELECT 1 AS x FROM ledger WHERE note_id = ? AND rev = ? AND rb = 1");
  return acks.filter((a) => !q.get(a.id, a.rev));
}
