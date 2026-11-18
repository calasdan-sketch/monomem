// Held writes (quarantine, 1.5.0 store split, moved out of store.ts): holding a flagged write, listing and reading held rows,
// approve / keep-as-history / reject, and the review context. Free functions over the Store; Store keeps a one-line delegate
// for each. Imports `type { Store }` only.

import type { HeldRow, NoteRecord, QuarantineContext, QuarantineEntry, Store } from "../store.js";
import { cleanWriter, currentWriter } from "../actor.js";
import { StaleWriteError, ValidationError, heldHandled } from "../errors.js";
import type { LintFinding } from "../lint.js";
import { DEFAULT_SENSITIVITY } from "../sensitivity.js";
import { contentHash as syncContentHash } from "../sync-hash.js";
import { contentHash as attestContentHash } from "../attest.js";
import { isTainted } from "../taint.js";
import { tokenize } from "../text-sim.js";
import { clampInt, isoOrNull, openQuarantineCol, parseTags, sealQuarantineCol } from "./rows.js";

/** Hold a linter-flagged write for admin review; returns its quarantine id. */
export function quarantineWrite(s: Store, q: {
    op: "create" | "update";
    targetId?: number;
    ifRev?: number;
    namespace: string;
    title?: string;
    body?: string;
    tags?: string[];
    source?: string;
    createdAt?: string;
    /** The write's forget_after days and confidence claim, applied on approval (v20; before, a hold dropped them). */
    forgetAfter?: number | null;
    /** A patch's `confidence: null` (clear) is carried too (the `clears` column), so approval clears it. */
    confidence?: number | null;
    /** op=update: the original patch moved the note to `namespace`. */
    setNamespace?: boolean;
    /** The label the held write carries (create: the new note's; update: the note's label after the write). */
    sensitivity?: string;
    findings: LintFinding[];
    /** Internal override of the stamped writer (default: the current writer). */
    writtenBy?: string;
    /** Another machine's sync file: applied with imported_unverified ... */
    importedUnverified?: boolean;
    /** ... and (create) linked to its (origin, id). */
    syncIdentity?: { origin: string; id: number };
  }): number {
  // Held writes are the flagged ones (secrets, injections): when at-rest
  // encryption is on they are sealed too. The key state is read under the
  // write lock (see writeKey) so a concurrent `encrypt disable` cannot
  // strand a sealed row.
  const nested = s.db.isTransaction;
  // What a held EDIT clears (confidence / forget_after set to null) is stored in the INSERT itself, not by a second statement.
  const clears = q.op === "update" ? (["forget_after", "confidence"] as const).filter((f) => (f === "confidence" ? q.confidence : q.forgetAfter) === null) : [];
  if (!nested) s.beginWrite();
  let id: number;
  try {
    const key = s.writeKey();
    // Sealed rows are bound to their id (S-05): inserted with empty columns, sealed below in this same transaction.
    const sealCol = (col: string, v: string | null): string | null => (v === null || !key ? v : "");
    const res = s.db
      .prepare(
        `INSERT INTO quarantine (op, target_id, if_rev, namespace, title, body, tags, source,
                                 created_at_override, reasons, created_at, set_namespace, sealed, written_by, sensitivity,
                                 forget_after, confidence, clears)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        q.op,
        q.targetId ?? null,
        q.ifRev ?? null,
        q.namespace,
        sealCol("title", q.title ?? null),
        sealCol("body", q.body ?? null),
        sealCol("tags", q.tags === undefined ? null : JSON.stringify(q.tags)),
        q.source === undefined ? null : q.source.replace(/[\u{E0000}-\u{E007F}]/gu, ""),
        isoOrNull(q.createdAt),
        JSON.stringify(q.findings),
        new Date().toISOString(),
        q.setNamespace ? 1 : 0,
        key ? 1 : 0,
        q.writtenBy !== undefined ? cleanWriter(q.writtenBy) : currentWriter(),
        q.sensitivity ?? DEFAULT_SENSITIVITY,
        q.forgetAfter ?? null,
        typeof q.confidence === "number" ? q.confidence : null,
        clears.length ? JSON.stringify(clears) : null
      );
    id = Number(res.lastInsertRowid);
    // R2-08: a write the linter held counts against its writer; an approve-first hold is the namespace's policy, not the write's.
    if (q.findings.some((f) => f.category !== "approval")) s.recordWriterEvent(q.writtenBy !== undefined ? cleanWriter(q.writtenBy) : currentWriter(), "quarantined", null);
    if (key) {
      const seal = (col: string, v: string | null): string | null => (v === null ? null : sealQuarantineCol(v, key, col, q.namespace, id));
      s.db
        .prepare("UPDATE quarantine SET title = ?, body = ?, tags = ? WHERE id = ?")
        .run(seal("title", q.title ?? null), seal("body", q.body ?? null), seal("tags", q.tags === undefined ? null : JSON.stringify(q.tags)), id);
    }
    if (q.importedUnverified || q.syncIdentity) {
      s.db
        .prepare("UPDATE quarantine SET imported_unverified = ?, sync_origin = ?, sync_origin_id = ? WHERE id = ?")
        .run(q.importedUnverified ? 1 : 0, q.syncIdentity?.origin ?? null, q.syncIdentity?.id ?? null, id);
    }
    if (!nested) s.commitTx();
  } catch (e) {
    if (!nested) {
      try {
        s.rollbackTx();
      } catch {
        /* already rolled back */
      }
    }
    throw e;
  }
  // Audit records the decision, never the content.
  // The receipt (never the line) carries the hash of what was held, and the note it would change.
  s.audit({ op: "quarantine", id, namespace: q.namespace, bytes: (q.body ?? "").length }, { ...(q.targetId !== undefined ? { note_id: q.targetId } : {}), content_hash: attestContentHash(q.title ?? "", q.body ?? "", q.tags ?? []) });
  return id;
}

export function quarantineRow(s: Store, row: Record<string, unknown>): QuarantineEntry {
  if (Number(row.sealed) === 1) {
    const key = s.readKey();
    const ns = String(row.namespace);
    try {
      for (const col of ["title", "body", "tags"]) {
        if (typeof row[col] === "string") row[col] = openQuarantineCol(row[col] as string, key, col, ns, Number(row.id));
      }
    } catch {
      throw new ValidationError(
        `held write #${row.id} cannot be opened: it was damaged or moved, or the encryption key is missing or changed. Throw it away with: monomem review held reject ${row.id}`
      );
    }
  }
  let reasons: LintFinding[] = [];
  try {
    reasons = JSON.parse(String(row.reasons)) as LintFinding[];
  } catch {
    /* corrupt row: show it with no reasons rather than hide it */
  }
  return {
    id: Number(row.id),
    op: row.op === "update" ? "update" : "create",
    target_id: row.target_id === null ? null : Number(row.target_id),
    namespace: String(row.namespace),
    title: (row.title as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    tags: row.tags === null ? null : parseTags(String(row.tags)),
    source: (row.source as string | null) ?? null,
    written_by: typeof row.written_by === "string" ? row.written_by : "",
    reasons,
    created_at: String(row.created_at),
  };
}

export function listQuarantine(s: Store, opts: { namespaces?: string[]; limit?: number } = {}): QuarantineEntry[] {
  if (opts.namespaces && opts.namespaces.length === 0) return [];
  const limit = clampInt(opts.limit, 50, 1, 500);
  const where = `WHERE 1 = 1${
    opts.namespaces ? ` AND namespace IN (${opts.namespaces.map(() => "?").join(",")})` : ""
  }${s.ceilingSql()}`;
  const rows = s.db
    .prepare(`SELECT * FROM quarantine ${where} ORDER BY id ASC LIMIT ?`)
    .all(...(opts.namespaces ?? []), limit) as Array<Record<string, unknown>>;
  // final-security SF3: one held row that does not open is listed as such; it must not hide the rest of the queue.
  return rows.map((r) => {
    try {
      return s.quarantineRow({ ...r });
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      return s.quarantineRow({ ...r, sealed: 0, title: "[sealed: cannot be opened]", body: null, tags: null });
    }
  });
}

export function getQuarantine(s: Store, id: number): QuarantineEntry | null {
  const row = s.db.prepare("SELECT * FROM quarantine WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  // A held write above the caller's ceiling does not exist as far as it can tell.
  return row && !s.hiddenByCeiling(row as { sensitivity?: string | null }) ? s.quarantineRow(row) : null;
}

export function approveQuarantine(s: Store, id: number): NoteRecord {
  if (!s.getQuarantine(id)) throw new ValidationError(`no quarantined write with id ${id}`);
  // The row is read again INSIDE the write transaction: another process may have approved or rejected it since the check above.
  const done = s.transaction(() => {
    const q = s.getQuarantine(id);
    if (!q) throw heldHandled(id);
    const note = s.applyHeld(id, q);
    s.recordWriterEvent(q.written_by ?? "", "held_approved", note.id); // the writer's own notice (store/held-outcomes.ts); not a reputation count
    return { note, namespace: q.namespace };
  });
  s.audit({ op: "quarantine-approve", id, namespace: done.namespace });
  return done.note;
}

/**
 * Apply held write `id` (caller holds a transaction) and drop it from the queue.
 *
 * Times (1.4.0): the note keeps the time the write was WRITTEN (the hold time), not the approval time, so a late approval
 * cannot make an old claim outrank a correction saved while it waited. approved_at/approved_by record the approval.
 *  - create: created_at = the write's own created_at if it sent one, else the hold time; updated_at = the hold time.
 *  - update: updated_at = the hold time, but never earlier than the note's current updated_at. The rev pin
 *    (compare-and-swap) already guarantees the note did not change since the hold, so this only guards clock skew and
 *    paths that touch updated_at without a rev bump; the note's time never moves backwards.
 * forget_after counts from that written time; confidence is the writer's claim, as if the write had gone straight in.
 */
export function applyHeld(s: Store, id: number, q: QuarantineEntry): NoteRecord {
  const held = s.db
    .prepare(
      `SELECT op, if_rev, set_namespace, created_at, created_at_override, written_by, sensitivity, imported_unverified,
              sync_origin, sync_origin_id, forget_after, confidence, clears FROM quarantine WHERE id = ?`
    )
    .get(id) as unknown as HeldRow | undefined;
  if (!held) throw heldHandled(id);
  const note = q.op === "create" ? s.applyHeldCreate(q, held) : s.applyHeldUpdate(id, q, held);
  s.db.prepare("UPDATE notes SET approved_at = ?, approved_by = ? WHERE id = ?").run(new Date().toISOString(), currentWriter(), note.id);
  s.db.prepare("DELETE FROM quarantine WHERE id = ?").run(id);
  return s.read(note.id)!;
}

/** The held write's forget_after and confidence as a patch; a held EDIT that cleared one (null) clears it again. */
export function heldExtras(s: Store, held: HeldRow, id: number): { forget_after?: number; confidence?: number | null } {
  let clears: string[] = [];
  try {
    clears = held.clears ? (JSON.parse(held.clears) as string[]) : [];
    if (!Array.isArray(clears)) throw new Error("not a list");
  } catch {
    // A damaged list must not quietly clear nothing: the approved edit would keep a value the writer meant to remove.
    throw new ValidationError(`held write ${id} has a damaged record of what it clears, so it cannot be approved safely; reject it and re-submit the change`);
  }
  return {
    ...(held.forget_after !== null ? { forget_after: Number(held.forget_after) } : clears.includes("forget_after") ? { forget_after: null as unknown as number } : {}),
    ...(held.confidence !== null ? { confidence: Number(held.confidence) } : clears.includes("confidence") ? { confidence: null } : {}),
  };
}

export function applyHeldCreate(s: Store, q: QuarantineEntry, held: HeldRow): NoteRecord {
  const note = s.create(
    {
      namespace: q.namespace,
      title: q.title ?? "",
      body: q.body ?? "",
      tags: q.tags ?? undefined,
      source: q.source ?? undefined,
      created_at: held.created_at_override ?? held.created_at,
      sensitivity: held.sensitivity,
      // A create has nothing to clear (heldExtras clears only for an edit), so no null reaches here.
      ...(s.heldExtras(held, q.id) as { forget_after?: number; confidence?: number }),
    },
    { lint: "none", writtenBy: held.written_by ?? "", importedUnverified: Number(held.imported_unverified) === 1, updatedAt: held.created_at }
  );
  if (held.sync_origin !== null && held.sync_origin_id !== null) {
    s.syncLink(held.sync_origin, Number(held.sync_origin_id), note.id);
    // What this store has now synced for the note, so an origin edit before the next sync merges as an update.
    s.setSyncBase(note.id, syncContentHash(note));
  }
  return note;
}

export function applyHeldUpdate(s: Store, id: number, q: QuarantineEntry, held: HeldRow): NoteRecord {
  // Rows from before 1.1.0 may lack the rev the update was based on;
  // applying them unguarded could overwrite later edits.
  if (held.if_rev === null) {
    throw new ValidationError(
      `held update #${id} predates rev tracking, so it can't be applied safely; reject it and re-submit the change`
    );
  }
  // A stale if_rev makes update() throw "stale write" -- a conflict the
  // admin resolves (reject, or re-submit), never a silent overwrite.
  let updated: NoteRecord | null;
  try {
    updated = s.update(
    q.target_id ?? -1,
    {
      ...(held.set_namespace ? { namespace: q.namespace } : {}),
      ...(q.title !== null ? { title: q.title } : {}),
      ...(q.body !== null ? { body: q.body } : {}),
      ...(q.tags !== null ? { tags: q.tags } : {}),
      ...(q.source !== null ? { source: q.source } : {}),
      // The rev pin above means the note is exactly as it was when the write was held, so re-applying its label is a no-op
      // unless the write itself relabelled the note.
      sensitivity: held.sensitivity,
      ...s.heldExtras(held, id),
    },
    { ifRev: held.if_rev, lint: "none", writtenBy: held.written_by ?? "", importedUnverified: Number(held.imported_unverified) === 1, writtenAt: held.created_at }
    );
  } catch (e) {
    if (e instanceof StaleWriteError) throw new StaleWriteError("The note changed since this edit was held; reject it or edit the note by hand.");
    throw e;
  }
  if (!updated) {
    throw new ValidationError(
      `held update #${id} targets note ${q.target_id}, which no longer exists; reject it instead`
    );
  }
  // A held sync update: record the synced content as the merge base (else the next origin edit looks like a conflict).
  if (held.sync_origin !== null) s.setSyncBase(updated.id, syncContentHash(updated));
  return updated;
}

export function quarantineContext(s: Store, id: number): QuarantineContext | null {
  const q = s.getQuarantine(id);
  if (!q) return null;
  const target = q.op === "update" && q.target_id !== null ? s.read(q.target_id) : null;
  // A held edit that leaves the title alone is about its target's topic.
  const topic = tokenize(`${q.title ?? target?.title ?? ""} ${(q.tags ?? []).join(" ")}`);
  const words = new Set(topic);
  // 1.5.0 (R1-17): every live note of the namespace saved since the hold, found by one query (the caller's ceiling and distrust
  // rules in the SQL), then matched on title words. Before, only the newest 500 notes by recency were looked at.
  // ponytail: title-word overlap; a ranked search if the queue ever needs fuzzier matching.
  const range = s.rangeFor({}, [q.namespace]);
  const rows = s.db
    .prepare(
      `SELECT id, title, tags, updated_at, written_by FROM notes WHERE namespace = ? AND updated_at >= ? AND id <> ? AND archived_at IS NULL${range.sql} ORDER BY updated_at DESC, id DESC LIMIT 2000`
    )
    .all(q.namespace, q.created_at, q.target_id ?? -1, ...range.params) as Array<{ id: number; title: string; tags: string; updated_at: string; written_by: string | null }>;
  const notes = rows
    .filter((n) => tokenize(`${n.title} ${parseTags(n.tags).join(" ")}`).some((w) => words.has(w)))
    .map((n) => ({ id: Number(n.id), title: n.title, updated_at: n.updated_at, written_by: n.written_by ?? "" }));
  return {
    id: q.id,
    op: q.op,
    target_id: q.target_id,
    namespace: q.namespace,
    held_at: q.created_at,
    ...(q.op === "update" ? { target_changed: !target || target.rev !== s.heldRev(id) } : {}),
    ...s.heldClears(id),
    notes,
  };
}

/** { clears } for a held edit that clears confidence or the forget date ({} when it clears nothing). */
export function heldClears(s: Store, id: number): { clears?: string[] } {
  const row = s.db.prepare("SELECT clears FROM quarantine WHERE id = ?").get(id) as { clears: string | null } | undefined;
  try {
    const list = row?.clears ? (JSON.parse(row.clears) as unknown) : null;
    return Array.isArray(list) && list.length ? { clears: list.filter((x): x is string => typeof x === "string") } : {};
  } catch {
    return {};
  }
}

/** The rev a held edit was written against (its compare-and-swap pin); null for a create or a pre-1.1.0 row. */
export function heldRev(s: Store, id: number): number | null {
  const row = s.db.prepare("SELECT if_rev FROM quarantine WHERE id = ?").get(id) as { if_rev: number | null } | undefined;
  return row?.if_rev ?? null;
}

export function keepQuarantineAsHistory(s: Store, id: number, byId?: number): { note: NoteRecord; superseded_by: number } {
  const ctx = s.quarantineContext(id);
  if (!ctx) throw new ValidationError(`no quarantined write with id ${id}`);
  if (!ctx.notes.length) {
    throw new ValidationError(
      `held write #${id}: nothing newer on the same topic was saved in "${ctx.namespace}" since it was held, so there is nothing to keep it as history of. Approve or reject it instead.`
    );
  }
  const by = byId === undefined ? ctx.notes[0] : ctx.notes.find((n) => n.id === byId);
  if (!by) throw new ValidationError(`note ${byId} is not one of the newer related notes saved since held write #${id} was held`);
  // 1.4.0: retiring one note in favour of another is a promotion of the other; neither side may be outside content no person
  // has confirmed. The CLI (behind its operator gate) decides that itself.
  if (currentWriter() !== "cli" && isTainted(s.getQuarantine(id)?.tags ?? [])) {
    throw new ValidationError(`Can't keep as history: held write #${id} came from outside content. A person must decide it in a terminal: monomem review held keep-history ${id}`);
  }
  const note = s.transaction(() => {
    // Inside the transaction: if applying the held write fails, the operator's pass is not left behind as a confirm.
    const held = s.getQuarantine(id); // read again here: another process may have decided it since the checks above
    if (!held) throw heldHandled(id);
    s.requireHumanConfirm(by.id, "use it as a replacement");
    const n = s.applyHeld(id, held);
    if (n.id === by.id) throw new ValidationError("a note cannot replace itself");
    const now = new Date().toISOString();
    const actor = currentWriter();
    const res = s.db
      .prepare(
        `UPDATE notes SET archived_at = ?, superseded_by = ?, superseded_at = ?, superseded_by_writer = ?, rev = rev + 1
         WHERE id = ? AND archived_at IS NULL AND superseded_by IS NULL`
      )
      .run(now, by.id, now, actor, n.id);
    if (Number(res.changes) === 0) throw new StaleWriteError(`note ${n.id} is no longer live; nothing was changed`);
    s.db
      .prepare("INSERT INTO supersede_log (at, actor, action, namespace, old_id, new_id, flags) VALUES (?, ?, 'supersede', ?, ?, ?, 'keep-history')")
      .run(now, actor, n.namespace, n.id, by.id);
    return n;
  });
  s.edgeIndexes.clear();
  s.audit({ op: "quarantine-keep-history", id, namespace: ctx.namespace });
  return { note: s.read(note.id)!, superseded_by: by.id };
}

export function rejectQuarantine(s: Store, id: number): boolean {
  // The plain columns only: a held write that does not open (damaged, key changed) can still be thrown away.
  const q = s.db.prepare("SELECT namespace, written_by, sensitivity FROM quarantine WHERE id = ?").get(id) as
    | { namespace: string; written_by: string | null; sensitivity?: string | null }
    | undefined;
  if (!q || s.hiddenByCeiling(q)) return false;
  // If another process decided it first, nothing is deleted and nothing is recorded. One transaction: the delete and the
  // writer event land together (SF-3).
  return s.transaction(() => {
    if (Number(s.db.prepare("DELETE FROM quarantine WHERE id = ?").run(id).changes) === 0) return false;
    s.recordWriterEvent(q.written_by ?? "", "rejected", null); // R2-08: rejecting a held write is an admin's or a person's decision
    s.audit({ op: "quarantine-reject", id, namespace: q.namespace });
    return true;
  });
}
