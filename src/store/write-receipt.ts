// R2-06 write receipts (1.5.0): an accepted, held or refused note write answers with `{seq, chain_hash, decision}`, the
// audit-log line that recorded it. `monomem verify-receipt <seq> <hash>` checks the line is still in an unbroken chain.
// No signing: the chain is unkeyed, so this proves the line was not edited or removed later, not who wrote the log.
// Free functions over the Store; Store keeps a one-line delegate for each. Imports `type { Store }` only.

import type { Store } from "../store.js";
import { QuarantinedError, ValidationError } from "../errors.js";

export type WriteDecision = "accepted" | "held" | "refused";
export interface WriteReceipt {
  seq: number;
  chain_hash: string;
  decision: WriteDecision;
}

/** The audit ops that answer a note write. */
const DECISION: Record<string, WriteDecision> = { create: "accepted", update: "accepted", quarantine: "held", "write-refused": "refused" };

/** Called with every audit line this store wrote: keeps the newest write decision for the caller to collect. */
export function noteAudited(s: Store, op: string, line: { seq: number; chain_hash: string } | undefined): void {
  const decision = DECISION[op];
  if (decision && line) s.lastWriteReceipt = { ...line, decision };
}

/**
 * The receipt of the write that just ran, cleared as it is read. Write calls are synchronous, so a surface that calls this
 * right after store.create / store.update (before any await) gets its own write's line. Undefined when nothing was audited:
 * an unchanged update (nothing written), an in-memory store, or an audit log that could not be written.
 */
export function takeWriteReceipt(s: Store): WriteReceipt | undefined {
  const r = s.lastWriteReceipt;
  s.lastWriteReceipt = undefined;
  return r;
}

/**
 * The receipt for a write that ended in `e`: a held write already has its "quarantine" line; a refused one (any
 * ValidationError: lint block, secret, paused writer, stale rev, bad tags) gets a "write-refused" line naming the error
 * class only, never its message or the note text. Any other error is a fault, not a decision: no receipt.
 */
export function refusedWriteReceipt(s: Store, e: unknown, id?: number): WriteReceipt | undefined {
  if (e instanceof QuarantinedError) return takeWriteReceipt(s);
  takeWriteReceipt(s);
  if (!(e instanceof ValidationError)) return undefined;
  s.audit({ op: "write-refused", ...(id !== undefined ? { id } : {}), detail: e.constructor.name });
  return takeWriteReceipt(s);
}
