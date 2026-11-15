// R2-06 write receipts (1.5.0): an accepted, held or refused note write answers with a receipt naming the audit-log line
// that recorded it. Receipt v2 (round 3) is Ed25519-signed by the key that signs the audit log (the store's .attest-key)
// and carries the note id, rev and a content hash of what was accepted or held. The content hash is in the receipt ONLY,
// never in the audit line: the log stays free of anything derived from note text (the writer already has the text).
// Offline check: `monomem verify-receipt --file r.json --pubkey <key>` or docs/verify-receipt.mjs (node:crypto only).
// Free functions over the Store; Store keeps a one-line delegate for each. Imports `type { Store }` only.

import type { Store } from "../store.js";
import { QuarantinedError, ValidationError, WriterPausedError } from "../errors.js";
import { RECEIPT_DOMAIN, contentHash, keyIdOf, signBytes, verifyBytes, type SigningKey } from "../attest.js";

/** Sent beside every write receipt (MCP and REST), so a person who sees one knows how to check it (1.5.0 final panel). */
export const RECEIPT_CHECK = "To check this receipt later, save it as a JSON file and run: monomem verify-receipt --file <receipt.json>";
/** "checkpoint": a signed head of the log (`monomem audit checkpoint`), same shape and same check as a write receipt. */
export type WriteDecision = "accepted" | "held" | "refused" | "checkpoint";
export interface WriteReceipt {
  v: 2;
  seq: number;
  chain_hash: string;
  decision: WriteDecision;
  ts: string;
  server_id: string;
  note_id?: number;
  rev?: number;
  /** attest.contentHash(title, body, tags) of what was accepted or held; absent for a refused write. */
  content_hash?: string;
  /** Absent when no key signs this store's log (no .attest-key beside it, or it could not be read). */
  key_id?: string;
  sig?: string;
}
/** A decision waiting to be collected: signed only when taken. */
export type PendingReceipt = Omit<WriteReceipt, "v" | "key_id" | "sig" | "server_id"> & { signer?: SigningKey };
/** What a write passes along for its receipt (never written to the log). */
export interface ReceiptContent {
  note_id?: number;
  rev?: number;
  content_hash?: string;
}

/** Receipt fields of a stored note: id, rev and the hash of its content as stored. */
export function receiptContent(n: { id: number; rev: number; title: string; body: string; tags: readonly string[] }): ReceiptContent {
  return { note_id: n.id, rev: n.rev, content_hash: contentHash(n.title, n.body, n.tags) };
}

/** The audit ops that answer a note write. */
const DECISION: Record<string, WriteDecision> = { create: "accepted", update: "accepted", quarantine: "held", "write-refused": "refused", "flood-pause": "refused" };

/** The bytes a receipt signature covers (docs/verify-receipt.mjs builds the same array). */
export function receiptBytes(r: Omit<WriteReceipt, "v" | "key_id" | "sig">): string {
  return JSON.stringify([RECEIPT_DOMAIN, r.server_id, r.seq, r.chain_hash, r.decision, r.ts, r.note_id ?? null, r.rev ?? null, r.content_hash ?? null]);
}

/** Build (and sign, with a key) a v2 receipt. */
export function makeReceipt(r: Omit<WriteReceipt, "v" | "key_id" | "sig">, key: SigningKey | undefined): WriteReceipt {
  const out: WriteReceipt = { v: 2, seq: r.seq, chain_hash: r.chain_hash, decision: r.decision, ts: r.ts, server_id: r.server_id, ...(r.note_id !== undefined ? { note_id: r.note_id } : {}), ...(r.rev !== undefined ? { rev: r.rev } : {}), ...(r.content_hash !== undefined ? { content_hash: r.content_hash } : {}) };
  return key ? { ...out, key_id: key.keyId, sig: signBytes(key, receiptBytes(out)) } : out;
}

/** The receipt's signature is good under `publicKey` (raw Ed25519, base64url) and its key_id names that key. */
export function verifyReceipt(r: Partial<WriteReceipt>, publicKey: string): boolean {
  if (!r || r.v !== 2 || typeof r.sig !== "string" || r.key_id !== keyIdOf(publicKey)) return false;
  return verifyBytes(publicKey, receiptBytes(r as WriteReceipt), r.sig);
}

/** Called with every audit line this store wrote: keeps the newest write decision (unsigned until taken) for the caller. */
export function noteAudited(s: Store, op: string, line: { seq: number; chain_hash: string; ts: string; signer?: SigningKey } | undefined, content: ReceiptContent = {}): void {
  const decision = DECISION[op];
  if (decision && line) s.lastWriteReceipt = { seq: line.seq, chain_hash: line.chain_hash, ts: line.ts, decision, signer: line.signer, ...content };
}

/**
 * The receipt of the write that just ran, cleared as it is read; signed here, so a write nobody collects costs no
 * signature. Write calls are synchronous, so a surface that calls this right after store.create / store.update (before
 * any await) gets its own write's line. Undefined when nothing was audited: an unchanged update (nothing written), an
 * in-memory store, or an audit log that could not be written.
 */
export function takeWriteReceipt(s: Store): WriteReceipt | undefined {
  const r = s.lastWriteReceipt;
  s.lastWriteReceipt = undefined;
  if (!r) return undefined;
  const { signer, ...rest } = r;
  return makeReceipt({ ...rest, server_id: s.serverId() }, signer);
}

/**
 * The receipt for a write that ended in `e`: a held write already has its "quarantine" line; a refused one (any
 * ValidationError: lint block, secret, paused writer, stale rev, bad tags) gets a "write-refused" line naming the error
 * class only, never its message or the note text. Any other error is a fault, not a decision: no receipt.
 */
export function refusedWriteReceipt(s: Store, e: unknown, id?: number): WriteReceipt | undefined {
  if (e instanceof QuarantinedError) return takeWriteReceipt(s);
  // SF-6: the write that tripped the flood guard already wrote its own "flood-pause" line (a refusal): that is its one line.
  if (e instanceof WriterPausedError && s.lastWriteReceipt?.decision === "refused") return takeWriteReceipt(s);
  s.lastWriteReceipt = undefined;
  if (!(e instanceof ValidationError)) return undefined;
  s.audit({ op: "write-refused", ...(id !== undefined ? { id } : {}), detail: e.constructor.name }, id !== undefined ? { note_id: id } : {});
  return takeWriteReceipt(s);
}
