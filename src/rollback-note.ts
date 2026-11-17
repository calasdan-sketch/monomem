// Roll back by note (plan C23): undo one bad note and what was built on it. Same two steps and the same machinery as the
// writer rollback (rollback.ts): a preview that writes nothing plus a one-time code, then a confirm that re-plans under the
// write lock, refuses if anything differs, and applies it all in ONE transaction. Nothing is deleted.
//
// The plan, from blast-radius.ts's answer for the note:
//   - the note itself                                   -> archive it (skipped when replaced; nothing when already archived);
//   - notes it replaced, still replaced (proven)        -> bring them back (unreplace);
//   - its open flags                                    -> clear them (the rollback settles them);
//   - notes saved with derived_from naming it (proven)  -> archive the ones created that way, put back the earlier text of the
//                                                          ones changed that way (the writer rollback's per-note rule);
//   - likely ones (same writer, after reading it) and tasks claimed after reading it: only with include_likely.
// Kept from the writer rollback: original authorship on restored text; pinned notes and approve-first namespaces are the CLI's
// alone; a flag raised at this computer (cli, a local app) is never cleared by an app key (r3 security S1); conflicts (another
// writer changed it later) are skipped unless include_conflicts.
import { randomBytes } from "node:crypto";
import { currentWriter, isWriterMarker } from "./actor.js";
import { audit } from "./security.js";
import { Store, StaleWriteError, type NoteRecord } from "./store.js";
import { SupersedeError, callerKey, supersedeTtlSeconds, type Caller } from "./supersede.js";
import { safe } from "./supersede-text.js";
import { nameIs } from "./trust.js";
import { stateOf } from "./task-core.js";
import { noteTouched } from "./blast-radius.js";
import {
  applyNoteStep,
  applySideEffect,
  gate,
  operatorOnlySkip,
  planHash,
  planNote,
  type RollbackItem,
  type RollbackResult,
  type RollbackSkip,
} from "./rollback.js";

const TOKEN_DOMAIN = "rollback-note-v1";
const TEXT_LIST_MAX = 50;

export interface NoteRollbackPlan {
  note: number;
  include_likely: boolean;
  include_conflicts: boolean;
  actions: RollbackItem[];
  skipped: RollbackSkip[];
  /** Likely items left out because include_likely was not set (a count, so the person knows to look). */
  likely_left_out: number;
}

export interface NoteRollbackPreview extends NoteRollbackPlan {
  ok: true;
  warning: string;
  token: string;
  expires_at: string;
  expires_in_seconds: number;
}

/** A flag raised at this computer (the person at the CLI, or a local app) can hold a task for a person (r3 S1). */
const localFlagger = (by: string): boolean => isWriterMarker(by) || by.startsWith("stdio:");

function openFlags(store: Store, id: number): Array<{ id: number; flagged_by: string }> {
  return store.db.prepare("SELECT id, flagged_by FROM note_flags WHERE note_id = ? AND cleared_at IS NULL ORDER BY id").all(id) as Array<{ id: number; flagged_by: string }>;
}

function parseNoteId(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*#?\d{1,15}\s*$/.test(raw) ? Number(raw.replace("#", "")) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new SupersedeError("note is required: the id of the note to roll back");
  return n;
}

/** Work out what rolling back one note would do. Reads only. */
export function planNoteRollback(store: Store, id: number, includeLikely: boolean, includeConflicts: boolean, namespaces?: string[]): NoteRollbackPlan {
  const operator = currentWriter() === "cli";
  const root = store.read(id); // gate-ok: operator rollback (admin), confined to the caller's namespaces just below
  if (!root || (namespaces && !namespaces.includes(root.namespace))) throw new SupersedeError(`no note ${id}`, 404);
  const t = noteTouched(store, root, { namespaces, operator: true });
  const actions: RollbackItem[] = [];
  const skipped: RollbackSkip[] = [];
  const base = (n: NoteRecord, basis: RollbackItem["basis"]) => ({ id: n.id, namespace: n.namespace, title: n.title, ...(n.pinned ? { pinned: true as const } : {}), basis });
  const done = new Set<number>(); // one archive / restore / release per note
  let likelyLeftOut = 0;

  // 1. Flags on the note, then the note itself.
  const flags = openFlags(store, root.id);
  const clearable = operator ? flags : flags.filter((f) => !localFlagger(f.flagged_by));
  if (clearable.length < flags.length) {
    skipped.push({ ...base(root, "the note"), reason: "operator_only", detail: "a person or local app on this computer raised a flag on it: only the monomem CLI can clear that flag" });
  }
  if (root.status === "superseded" || root.superseded_by != null) {
    skipped.push({ ...base(root, "the note"), reason: "replaced", detail: `replaced by ${root.superseded_by != null ? `note ${root.superseded_by}` : "another note"}; undo that replacement first` });
  } else if (!root.archived_at && !operatorOnlySkip(store, root, operator, skipped, { basis: "the note" })) {
    if (clearable.length) actions.push({ ...base(root, "the note"), rev: root.rev, action: "unflag", flags: clearable.length });
    actions.push({ ...base(root, "the note"), rev: root.rev, action: "archive" });
    done.add(root.id);
  }

  // 2. Notes it replaced (proven).
  for (const r of t.replaced) {
    const n = store.read(r.id); // gate-ok: operator rollback (admin), within the caller's namespaces (noteTouched)
    if (!n || operatorOnlySkip(store, n, operator, skipped, { basis: "proven" })) continue;
    actions.push({ ...base(n, "proven"), rev: n.rev, action: "unreplace", replaced_by: root.id });
  }

  // 3. Notes built on it.
  for (const b of t.built_on) {
    if (b.basis === "likely" && !includeLikely) {
      likelyLeftOut++;
      continue;
    }
    const n = store.read(b.id); // gate-ok: operator rollback (admin), within the caller's namespaces (noteTouched)
    if (!n || done.has(n.id)) continue;
    // Proven: everything that writer changed here since the note existed. Likely: since that writer's first write after reading it.
    const since = b.basis === "proven" ? root.created_at : b.at;
    const before = actions.length;
    planNote(store, n, (v) => nameIs(v, b.by, false), since, includeConflicts, operator, actions, skipped, { basis: b.basis });
    if (actions.length > before) done.add(n.id);
  }

  // 4. Tasks claimed after reading it (likely): release a claim that is still that writer's live lease.
  const now = Date.now();
  for (const c of t.claimed_tasks) {
    if (!includeLikely) {
      likelyLeftOut++;
      continue;
    }
    const task = store.read(c.id); // gate-ok: operator rollback (admin), within the caller's namespaces (noteTouched)
    if (!task || done.has(task.id)) continue;
    const st = stateOf(task);
    if (!st.claim || !st.lease || st.lease.expMs <= now || st.claim.by !== c.by) continue;
    if (operatorOnlySkip(store, task, operator, skipped, { basis: "likely" })) continue;
    actions.push({ ...base(task, "likely"), rev: task.rev, action: "release", back_to: st.claim.prev });
    done.add(task.id);
  }
  return { note: root.id, include_likely: includeLikely, include_conflicts: includeConflicts, actions, skipped, likely_left_out: likelyLeftOut };
}

function previewText(p: NoteRollbackPlan, ttl: number, how: string): string {
  const tag = (b: RollbackItem["basis"]): string => (b === "the note" ? " (the note itself)" : b ? ` (${b})` : "");
  const line = (x: { id: number; namespace: string; title: string; pinned?: true; basis?: RollbackItem["basis"] }): string =>
    `note ${x.id} [${safe(x.namespace, 40)}] "${safe(x.title, 80)}"${x.pinned ? " (PINNED)" : ""}${tag(x.basis)}`;
  const list = <T,>(rows: T[], f: (r: T) => string): string[] => [
    ...rows.slice(0, TEXT_LIST_MAX).map((r) => "  - " + f(r)),
    ...(rows.length > TEXT_LIST_MAX ? [`  ... and ${rows.length - TEXT_LIST_MAX} more (see the JSON)`] : []),
  ];
  const of = (k: RollbackItem["action"]) => p.actions.filter((a) => a.action === k);
  const out = [`Roll back note ${p.note} and what was built on it${p.include_likely ? " (likely ones too)" : ""}:`];
  if (p.actions.length === 0) out.push("Nothing to do.");
  const [arch, rest, unrep, unflag, rel] = [of("archive"), of("restore"), of("unreplace"), of("unflag"), of("release")];
  if (arch.length) out.push(`Archive ${arch.length} note(s):`, ...list(arch, (a) => line(a) + (a.conflict ? " (others changed it too)" : "")));
  if (rest.length) out.push(`Put back the earlier text of ${rest.length} note(s):`, ...list(rest, (a) => `${line(a)} -> version ${a.restore_version}${a.conflict ? " (overwrites later changes by others)" : ""}`));
  if (unrep.length) out.push(`Bring back ${unrep.length} note(s) it replaced:`, ...list(unrep, (a) => line(a)));
  if (unflag.length) out.push(`Clear the open flags on it (the rollback settles them):`, ...list(unflag, (a) => `${line(a)} (${a.flags} flag${a.flags === 1 ? "" : "s"})`));
  if (rel.length) out.push(`Release ${rel.length} task claim(s):`, ...list(rel, (a) => `${line(a)} -> back to ${a.back_to}`));
  if (p.skipped.length) out.push(`Skipped ${p.skipped.length}:`, ...list(p.skipped, (s) => `${line(s)}: ${s.reason.replace(/_/g, " ")}, ${s.detail}`));
  if (p.likely_left_out) {
    out.push(`Left out ${p.likely_left_out} likely item(s): written or claimed by an app after it read the note, with no recorded link. ` +
      "Check them with `monomem why " + p.note + " --touched`; add --include-likely to undo them too.");
  }
  if (p.actions.length === 0) return out.join("\n");
  out.push(
    "Nothing is deleted: archived notes come back with `monomem restore <id>`, and each restored note keeps the text it replaces in its history " +
      "(`monomem history restore <id> <version>` undoes it).",
    `This plan can be confirmed once, within ${Math.round(ttl / 60)} minute(s). ${how}`
  );
  return out.join("\n");
}

/** Step 1. Reads only. */
export function noteRollbackPreview(
  store: Store,
  caller: Caller,
  req: { note: unknown; include_likely?: unknown; include_conflicts?: unknown },
  howToConfirm = "To go ahead, confirm with this code: {token}"
): NoteRollbackPreview {
  const namespaces = gate(caller);
  const id = parseNoteId(req.note);
  const plan = planNoteRollback(store, id, req.include_likely === true, req.include_conflicts === true, namespaces);
  const ttl = supersedeTtlSeconds();
  const expMs = Date.now() + ttl * 1000;
  const token = store.mintToken(TOKEN_DOMAIN, {
    n: id,
    l: plan.include_likely ? 1 : 0,
    c: plan.include_conflicts ? 1 : 0,
    h: planHash({ writer: "", since: "", include_conflicts: plan.include_conflicts, actions: plan.actions, skipped: plan.skipped }),
    k: callerKey(caller),
    e: expMs,
    x: randomBytes(12).toString("hex"),
  });
  return { ok: true, ...plan, warning: previewText(plan, ttl, howToConfirm.replace("{token}", token)), token, expires_at: new Date(expMs).toISOString(), expires_in_seconds: ttl };
}

/** Step 2. A valid, unexpired, unused code made for this caller; applies the previewed plan atomically or nothing. */
export function noteRollbackConfirm(store: Store, caller: Caller, req: { token: unknown }): RollbackResult & { note: number } {
  const namespaces = gate(caller);
  if (typeof req.token !== "string" || !req.token) throw new SupersedeError("a confirmation code from the preview is required");
  const t = store.openToken(TOKEN_DOMAIN, req.token);
  if (!t || t.k !== callerKey(caller)) throw new SupersedeError("that is not a valid confirmation code (it may have been copied wrongly); run the preview again");
  const exp = Number(t.e);
  if (!Number.isFinite(exp) || Date.now() > exp) throw new SupersedeError("that confirmation code has expired; run the preview again", 410);
  const nonce = String(t.x ?? "");
  if (!/^[0-9a-f]{24}$/.test(nonce)) throw new SupersedeError("that is not a valid confirmation code; run the preview again");
  if (store.tokenSpent(nonce)) throw new SupersedeError("that confirmation code was already used; run the preview again", 410);
  const id = Number(t.n);
  const operator = currentWriter() === "cli";

  const out = store.transaction(() => {
    store.spendNonce(nonce, exp);
    const plan = planNoteRollback(store, id, Number(t.l) === 1, Number(t.c) === 1, namespaces);
    const h = planHash({ writer: "", since: "", include_conflicts: plan.include_conflicts, actions: plan.actions, skipped: plan.skipped });
    if (h !== t.h) throw new StaleWriteError("notes changed since the preview; nothing was changed. Run the preview again");
    const archived: number[] = [];
    const restored: RollbackResult["restored"] = [];
    const done = { unreplaced: [] as number[], unflagged: [] as number[], released: [] as number[] };
    for (const a of plan.actions) {
      if (a.action === "unflag") {
        const ids = openFlags(store, a.id).filter((f) => operator || !localFlagger(f.flagged_by)).map((f) => f.id);
        const at = new Date().toISOString();
        for (const fid of ids) store.db.prepare("UPDATE note_flags SET cleared_at = ?, cleared_by = 'rollback' WHERE id = ? AND cleared_at IS NULL").run(at, fid);
        done.unflagged.push(a.id);
        continue;
      }
      // unreplace and release use no writer filter; the label goes into the replacement log as rollback:note:<id>.
      if (applySideEffect(store, a, `note:${id}`, "", done)) continue;
      applyNoteStep(store, a, archived, restored);
    }
    return { archived, restored, ...done, skipped: plan.skipped };
  });
  const more =
    (out.unreplaced.length ? `, brought back ${out.unreplaced.length}` : "") +
    (out.unflagged.length ? `, cleared flags on ${out.unflagged.length}` : "") +
    (out.released.length ? `, released ${out.released.length} task claim(s)` : "");
  audit({ op: "rollback", label: `note:${id}`, detail: `archived ${out.archived.length}, restored ${out.restored.length}${more}, skipped ${out.skipped.length}` });
  const message =
    `Rolled back note ${id} and what was built on it: archived ${out.archived.length}, restored ${out.restored.length}${more}, skipped ${out.skipped.length}. ` +
    "Undo: `monomem restore <id>` for an archived note, `monomem history restore <id> <version>` for a restored one.";
  return { ok: true, message, note: id, ...out };
}
