// Per-note seal (schema v23): notes.seal = HMAC-SHA256 over every column of a note that is not a read counter.
//
// What it is for: `state.db` is a plain SQLite file. A program, a sync tool, a bad restore or a hand-typed UPDATE can change a
// note's text or its `written_by` and nothing used to notice (RT-2). With a seal, such an edit leaves the row visibly unsealed
// or mismatched; doctor names it and agents are not shown its text.
//
// What it is NOT: protection against anyone who can read `.attest-key` as the same user. That key derives the seal key, so
// such a program can seal a forged row. Only an anchor kept somewhere else (a signed checkpoint, a receipt an agent holds)
// shows that afterwards. docs/trust.md and SECURITY.md say so.
//
// Key: HKDF-SHA256 over the 32-byte seed of the Ed25519 signing key (`.attest-key`), so the MAC key and the signing key are
// different keys. Message: a domain string and a JSON array of primitives (deterministic), the body as a keyed digest.

import { createHmac, createSecretKey, hash, hkdfSync, type KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { peekSigningKey, type SigningKey } from "../attest.js";

export const SEAL_DOMAIN = "monomem-seal-v1\n";
/** Every `notes` column covered by the seal except the body pair (those enter as a keyed digest), in message order. */
export const SEALED_META = [
  "namespace", "title", "tags", "created_at", "updated_at", "rev", "source", "expires_at", "archived_at", "written_by", "created_by",
  "imported_written_by", "imported_created_by", "attested_writer", "attested_by", "merged_from_writers", "confidence", "confidence_by",
  "superseded_by", "superseded_at", "superseded_by_writer", "kind", "session_id", "obs_type", "pinned", "sensitivity", "grandfathered_at",
  "approved_at", "approved_by", "confirmed_at", "confirmed_by", "confirmed_kind", "confirmed_rev", "cli_tty", "content_at", "writer_cwd",
  "imported_unverified",
] as const;
/** Columns that change on a plain read; the seal never covers them. */
export const VOLATILE_COLUMNS = ["access_count", "last_accessed"] as const;
export const BODY_COLUMNS = ["body", "body_enc"] as const;

export type SealStatus = "ok" | "unsealed" | "mismatch" | "skip";
type Row = Record<string, unknown>;

/** Raw seed of an Ed25519 key (the last 32 bytes of its PKCS8 DER). */
function seedOf(key: SigningKey): Buffer {
  return (key.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
}
/** The seal key for a signing key (a KeyObject: HMAC with one is several times cheaper than with raw bytes on every call). */
export function sealKeyOf(key: SigningKey): KeyObject {
  return createSecretKey(Buffer.from(hkdfSync("sha256", seedOf(key), "monomem-seal-v1", key.keyId, 32)));
}
export type MacKey = KeyObject | Buffer;

/** HMAC of the stored body form (plain text and ciphertext column), bound to the note id; stays in the ledger instead of a plain hash. */
export function bodyMacOf(key: MacKey, id: number, body: unknown, bodyEnc: unknown): string {
  const digest = hash("sha256", `${String(body ?? "")}\0${String(bodyEnc ?? "")}`, "hex");
  return macOf(key, `body\0${id}\0${digest}`);
}

/** The exact bytes that are MACed: the note id, the keyed body digest and every sealed column in order. */
export function sealMessage(id: number, bodyMac: string, meta: readonly unknown[]): string {
  return SEAL_DOMAIN + JSON.stringify([1, id, bodyMac, ...meta.map((v) => (v === undefined ? null : v))]);
}
export const metaOf = (row: Row): unknown[] => SEALED_META.map((c) => row[c] ?? null);
export const macOf = (key: MacKey, message: string): string => createHmac("sha256", key).update(message).digest().toString("base64url");

/** The seal of a full row (needs every sealed column; a narrow projection must not be sealed). */
export function sealOf(key: MacKey, row: Row): string {
  return macOf(key, sealMessage(Number(row.id), bodyMacOf(key, Number(row.id), row.body, row.body_enc), metaOf(row)));
}

/** Does `row` carry every column the seal needs? (A narrow SELECT does not.) */
export function hasSealColumns(row: Row): boolean {
  return row.seal !== undefined && row.body !== undefined && row.body_enc !== undefined && SEALED_META.every((c) => row[c] !== undefined);
}

/** The SQL text of the three seal triggers, generated from the column lists so they cannot drift from the seal. */
export function sealTriggerSql(): Record<"ai" | "au" | "ad", { name: string; sql: string }> {
  const cols = [...SEALED_META, ...BODY_COLUMNS].join(", ");
  const oldMeta = SEALED_META.map((c) => `old.${c}`).join(", ");
  return {
    ai: {
      name: "notes_seal_ai",
      sql: `CREATE TRIGGER notes_seal_ai AFTER INSERT ON notes WHEN new.seal IS NULL BEGIN INSERT OR IGNORE INTO seal_dirty(id, op, old_seal, old_meta, rev0, arch0) VALUES (new.id, 'c', NULL, NULL, 0, 0); END`,
    },
    au: {
      name: "notes_seal_au",
      sql: `CREATE TRIGGER notes_seal_au AFTER UPDATE OF ${cols} ON notes WHEN new.seal IS old.seal BEGIN
  INSERT OR IGNORE INTO seal_dirty(id, op, old_seal, old_meta, rev0, arch0) VALUES (new.id, 'u', old.seal, json_array(${oldMeta}), old.rev, old.archived_at IS NOT NULL);
  UPDATE seal_dirty SET bchg = 1 WHERE id = new.id AND (old.body IS NOT new.body OR old.body_enc IS NOT new.body_enc);
  UPDATE notes SET seal = NULL WHERE id = new.id;
END`,
    },
    ad: {
      name: "notes_seal_ad",
      sql: `CREATE TRIGGER notes_seal_ad AFTER DELETE ON notes BEGIN INSERT OR REPLACE INTO seal_dirty(id, op, old_seal, old_meta, rev0, arch0) VALUES (old.id, 'd', old.seal, NULL, old.rev, 0); END`,
    },
  };
}

/**
 * Per-store seal state: the cached seal key (re-checked against the key file at most once a second, so a rotation from the CLI
 * takes effect in a running server within a second), the key id the seals were made under, and the dirty rows that were already
 * there when this write began (left by something other than Monomem's own commit path: never resealed).
 */
export class SealState {
  private cached: { key: KeyObject; id: string; at: number } | null = null;
  /** Note ids that were in seal_dirty when the current write transaction began. */
  foreign: Set<number> | null = null;
  private metaCache: { at: number; backfillDone: boolean; keyId: string } | null = null;
  constructor(
    private readonly keyDir: () => string,
    private readonly inMemory: () => boolean,
    private readonly signing: () => SigningKey,
    private readonly meta: (k: string) => string | null,
    private readonly db: () => DatabaseSync
  ) {}

  /** A row this very transaction wrote and has not sealed yet (it is sealed at COMMIT): reading it back must not call it unsealed. */
  pending(id: number): boolean {
    const db = this.db();
    return db.isTransaction && !this.foreign?.has(id) && db.prepare("SELECT 1 AS x FROM seal_dirty WHERE id = ?").get(id) !== undefined;
  }

  /** The signing key to use for a write (creates `.attest-key` on first use). */
  signingKey(): SigningKey {
    return this.signing();
  }

  /** The seal key and the id of the signing key it comes from. `create`: a write may make the key file; a read never does. */
  key(create: boolean): { key: KeyObject; id: string } | null {
    const now = Date.now();
    if (this.cached && (this.inMemory() || now - this.cached.at < 1000)) return this.cached;
    let sk: SigningKey | null = null;
    if (create) sk = this.signing();
    else sk = this.inMemory() ? this.signing() : peekSigningKey(this.keyDir());
    if (!sk) return null;
    if (this.cached?.id === sk.keyId) this.cached.at = now;
    else this.cached = { key: sealKeyOf(sk), id: sk.keyId, at: now };
    return this.cached;
  }

  /** Forget the cached key (after a rotation). */
  reset(): void {
    this.cached = null;
    this.metaCache = null;
  }
  /** Forget the cached `_meta` facts (after this process changed them). */
  metaChanged(): void {
    this.metaCache = null;
  }

  /** `_meta` facts the read path needs, refreshed at most once a second. */
  state(): { backfillDone: boolean; keyId: string } {
    const now = Date.now();
    if (!this.metaCache || now - this.metaCache.at > 1000) {
      this.metaCache = { at: now, backfillDone: this.meta("seal_backfill_done") === "1", keyId: this.meta("seal_key_id") ?? "" };
    }
    return this.metaCache;
  }
}

/** How a row stands against its seal, with the current key. `skip`: cannot tell (narrow row, no key, key changed, not yet sealed). */
export function statusOf(st: SealState, row: Row): SealStatus {
  if (!hasSealColumns(row)) return "skip";
  const k = st.key(false);
  if (!k) return "skip";
  const s = st.state();
  if (s.keyId !== "" && s.keyId !== k.id) return "skip"; // the key changed under the seals: doctor says so; no note is withheld for it
  if (row.seal === null) return s.backfillDone && !st.pending(Number(row.id)) ? "unsealed" : "skip";
  return sealOf(k.key, row) === row.seal ? "ok" : "mismatch";
}

export const WITHHELD_TITLE = "[withheld: this note was changed outside Monomem]";
/** A record as an agent may see it: when the row fails its seal, the text and the provenance are replaced by a plain notice. */
export function guardRecord<T extends { title: string; body: string; tags: string[]; source: string }>(st: SealState, row: Row, rec: T): T {
  if (process.env.MONOMEM_SEAL_WITHHOLD === "off") return rec; // shows the text anyway; doctor and verify-lossless still report (the test suite edits rows by hand)
  const status = statusOf(st, row);
  if (status !== "unsealed" && status !== "mismatch") return rec;
  return {
    ...rec,
    title: WITHHELD_TITLE,
    body: `Monomem withheld this note (${status === "mismatch" ? "its seal does not match" : "it has no seal"}): its row in the database was edited by something other than Monomem. Run: monomem doctor`,
    tags: [],
    source: "",
    integrity: status,
  } as unknown as T;
}
