// Error classes shared by the store and its callers. Kept in their own module (1.5.0 store split) so a module that only
// needs to throw or catch one (facts.ts, reserved-tags.ts, src/store/*) does not import store.ts and join an import cycle.
// store.ts re-exports every one of them, so existing `from "./store.js"` imports keep working.

import { describeFindings } from "./lint-describe.js";
import type { LintFinding } from "./lint.js";

/**
 * A caller-input error (bad/oversized/secret-bearing data, empty title, stale
 * write). The HTTP layer maps these to 400 with the message shown; anything
 * else is an unexpected fault mapped to a generic 500, so internals never leak.
 */
export class ValidationError extends Error {}

/**
 * A stored note body could not be decrypted (wrong key file, or the row was
 * tampered with / moved). NOT a ValidationError: it is the operator's problem,
 * so the REST layer answers 500 -- but with this clear, id-bearing message
 * instead of a bare "internal error", and never hangs a stream.
 */
export class NoteUnreadableError extends Error {
  /** The key file's path when the cause is that it is missing (not a wrong key or altered data). */
  public readonly missingKey?: string;
  constructor(
    public readonly noteId: number,
    detail: string,
    cause?: unknown
  ) {
    // A missing key file is the likely cause and the one the person can fix: lead with it (1.5.0 final panel).
    super(
      cause instanceof MissingKeyError
        ? `the key file ${cause.keyFile} is missing, so note ${noteId} cannot be read. ${cause.fix}`
        : `note ${noteId} cannot be decrypted (wrong key file, or the stored data was altered): ${detail}`
    );
    if (cause instanceof MissingKeyError) this.missingKey = cause.keyFile;
  }
}

/** The database holds sealed bodies but the key file is gone. `fix` is the next step in plain words. */
export class MissingKeyError extends Error {
  constructor(
    public readonly keyFile: string,
    public readonly fix: string,
    message: string
  ) {
    super(message);
  }
}

/** The missing key file's path when `e` is (or wraps) a missing-key error, else undefined. */
export const missingKeyFile = (e: unknown): string | undefined =>
  e instanceof MissingKeyError ? e.keyFile : e instanceof NoteUnreadableError ? e.missingKey : undefined;

/**
 * A compare-and-swap update was refused because the note moved on since the caller read it
 * (`ifRev` no longer matches). A ValidationError subclass so every surface keeps its message;
 * the REST layer answers 409 so a client can tell "re-read and retry" from "bad request".
 */
export class StaleWriteError extends ValidationError {}
/** A held write another process (or an earlier click) already approved, kept as history or rejected: REST answers 409. */
export const heldHandled = (id: number): StaleWriteError => new StaleWriteError(`held write ${id} was already handled (approved, kept as history or rejected); refresh the list`);

/**
 * A rebuild was requested while another one is already running in this
 * process (single-flight). A ValidationError subclass so every surface maps
 * it to a clean caller-facing error; the REST layer answers 409.
 */
export class RebuildBusyError extends ValidationError {
  constructor() {
    super("a similarity-edge rebuild is already running; retry when it finishes");
  }
}

/**
 * A guarded duplicate-candidate scan (consolidate.ts findCandidatesGuarded)
 * was refused (one already running), cancelled, or ran out of time.
 */
export class CandidateScanError extends ValidationError {}

/**
 * A write held for admin review by the write-time linter (MONOMEM_LINT
 * quarantine policy). A ValidationError subclass so an unaware caller still
 * maps it to a clean caller-facing error; the REST and MCP write paths catch
 * it and report `{ quarantined: { id, reasons } }` instead.
 */
export class QuarantinedError extends ValidationError {
  constructor(
    readonly quarantineId: number,
    readonly findings: LintFinding[]
  ) {
    super(
      `held for review until an admin decides (held write #${quarantineId}: ${describeFindings(findings)})`
    );
  }
}

/** A write from a writer the flood guard paused (Store.floodGate). Cleared by an operator: `monomem resume <label>`. */
export class WriterPausedError extends ValidationError {}
