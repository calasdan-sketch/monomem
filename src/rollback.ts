// Roll back everything one writer did since a moment in time (operator only).
//
// Two steps, like supersede: `rollbackPreview` writes nothing and returns exactly what would happen plus a one-time code;
// `rollbackConfirm` re-plans under the write lock, refuses if anything differs from the preview, and applies it all in ONE
// transaction (all or nothing). Every surface (CLI, REST, the operator-only MCP tool) goes through this module.
//
// The plan, per note the writer touched since T (Store.rollbackCandidates):
//   - CREATED by the writer after T            -> archive it (never delete; `monomem restore` brings it back).
//   - its text CHANGED by the writer after T   -> put back the newest kept version from before the writer's first change after T
//                                                 (Store.restoreVersion: the text it replaces goes into the history, so
//                                                 memory_restore_version / `monomem history restore` reverses it).
//   - another writer changed the text after the writer's first change: a CONFLICT, skipped unless include_conflicts.
//   - the version needed was dropped from the bounded history (pruned or purged): "cannot fully undo", always skipped.
//   - replaced (superseded) or archived notes: skipped with the reason.
//   - pinned notes and notes in approve-first namespaces are the operator's alone: done from the CLI, skipped (and listed)
//     over REST and MCP, which count as agents.
// Writer names match exactly; "stdio" also means every stdio:<app> (the same family rule the distrust list uses).
import { createHash, randomBytes } from "node:crypto";
import { currentWriter, cleanWriter } from "./actor.js";
import { audit, scopeAllows } from "./security.js";
import { Store, StaleWriteError, historyLimits, type NoteRecord } from "./store.js";
import { SupersedeError, callerKey, supersedeTtlSeconds, type Caller } from "./supersede.js";
import { safe } from "./supersede-text.js";
import { maybeEmbed } from "./search-service.js";
import { nameIs, stdioFamily } from "./trust.js";

const TOKEN_DOMAIN = "rollback-v1";
/** How many lines of each list the plain-text preview prints (the JSON always has all of them). */
const TEXT_LIST_MAX = 50;

export interface RollbackItem {
  id: number;
  namespace: string;
  title: string;
  rev: number;
  action: "archive" | "restore";
  /** action "restore": the version that becomes the current text again. */
  restore_version?: number;
  pinned?: true;
  /** Applied although another writer changed the note later (include_conflicts). */
  conflict?: true;
}

export interface RollbackSkip {
  id: number;
  namespace: string;
  title: string;
  reason: "conflict" | "cannot_fully_undo" | "operator_only" | "replaced" | "archived";
  detail: string;
  pinned?: true;
}

export interface RollbackPlan {
  writer: string;
  since: string;
  include_conflicts: boolean;
  actions: RollbackItem[];
  skipped: RollbackSkip[];
}

export interface RollbackPreview extends RollbackPlan {
  ok: true;
  /** The plain-language summary. Show it to the person before they confirm. */
  warning: string;
  token: string;
  expires_at: string;
  expires_in_seconds: number;
}

/** `since`: an ISO date/time, or a duration back from now (30m, 2h, 7d, 1w). Returns ISO. */
export function parseSince(raw: unknown, now = Date.now()): string {
  if (typeof raw !== "string" || !raw.trim()) throw new SupersedeError("since is required: an ISO time (2026-11-04T09:00:00Z) or a duration (30m, 2h, 7d)");
  const t = raw.trim();
  const d = /^(\d+)\s*(m|h|d|w)$/i.exec(t);
  const ms = d ? now - Number(d[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[d[2].toLowerCase() as "m" | "h" | "d" | "w"] : Date.parse(t);
  if (!Number.isFinite(ms)) throw new SupersedeError(`since "${safe(t, 40)}" is not an ISO time or a duration like 30m, 2h, 7d`);
  if (ms > now) throw new SupersedeError("since is in the future");
  return new Date(ms).toISOString();
}

function parseWriter(raw: unknown): string {
  const w = cleanWriter(raw);
  if (!w) throw new SupersedeError('writer is required: the exact name from written_by (for example "token:ci" or "stdio:cursor"; "stdio" means every local app)');
  return w;
}

/** Work out what a rollback would do. Reads only. */
export function planRollback(store: Store, writer: string, since: string, includeConflicts: boolean, namespaces?: string[]): RollbackPlan {
  const family = stdioFamily(writer);
  const isW = (v: unknown): boolean => nameIs(v, writer, family);
  const operator = currentWriter() === "cli";
  const actions: RollbackItem[] = [];
  const skipped: RollbackSkip[] = [];
  for (const id of store.rollbackCandidates(writer, family, since, namespaces)) {
    const n = store.read(id); // gate-ok: operator rollback (admin), confined to the caller's namespaces by rollbackCandidates
    if (!n) continue;
    const base = { id, namespace: n.namespace, title: n.title, ...(n.pinned ? { pinned: true as const } : {}) };
    const step = decide(store, n, isW, since);
    if (!step) continue;
    if ("skip" in step) {
      skipped.push({ ...base, reason: step.skip, detail: step.detail });
      continue;
    }
    if (step.conflict && !includeConflicts) {
      skipped.push({ ...base, reason: "conflict", detail: step.conflict });
      continue;
    }
    if (!operator && (n.pinned || store.isApproveFirst(n.namespace))) {
      const why = n.pinned ? "the note is pinned" : `namespace "${n.namespace}" is approve-first`;
      skipped.push({ ...base, reason: "operator_only", detail: `${why}: only the monomem CLI can roll it back` });
      continue;
    }
    actions.push({ ...base, rev: n.rev, action: step.action, ...(step.version ? { restore_version: step.version } : {}), ...(step.conflict ? { conflict: true as const } : {}) });
  }
  return { writer, since, include_conflicts: includeConflicts, actions, skipped };
}

type Step = { action: "archive" | "restore"; version?: number; conflict?: string } | { skip: RollbackSkip["reason"]; detail: string } | null;

/** One note's verdict. `isW` matches the writer (with the stdio family). */
function decide(store: Store, n: NoteRecord, isW: (v: unknown) => boolean, since: string): Step {
  if (n.status === "superseded") return { skip: "replaced", detail: `replaced by ${n.superseded_by !== undefined ? `note ${n.superseded_by}` : "another note"}; undo that replacement first` };
  const hist = store.historyOf(n.id).reverse(); // oldest first
  const dropped = store.historyDropped(n.id);
  const others = (names: unknown[]): string[] => [...new Set(names.filter((x): x is string => typeof x === "string" && x !== "" && !isW(x)))];

  if (isW(n.created_by) && n.created_at >= since) {
    if (n.archived_at) return null; // already forgotten: nothing to undo
    const who = others([n.written_by, ...hist.map((e) => e.written_by), ...hist.map((e) => e.saved_by), ...dropped.map((d) => d.saved_by)]);
    return { action: "archive", ...(who.length ? { conflict: `also changed by ${who.map((w) => `"${safe(w, 40)}"`).join(", ")}` } : {}) };
  }

  const first = hist.find((e) => isW(e.saved_by) && e.saved_at >= since);
  const lostW = dropped.filter((d) => isW(d.saved_by) && d.last_at >= since);
  if (!first) {
    if (lostW.length || (historyLimits().versions === 0 && isW(n.written_by) && n.updated_at >= since)) {
      return { skip: "cannot_fully_undo", detail: "the text from before this writer's change is no longer in the history" };
    }
    return null; // the writer changed no text here after `since` (a tag or metadata edit leaves no version)
  }
  // An earlier change by the writer after `since` whose version was dropped: `first` would not be the right text.
  if (lostW.some((d) => d.first_at < first.saved_at)) {
    return { skip: "cannot_fully_undo", detail: `an earlier change by this writer is no longer in the history; the oldest kept one replaced version ${first.version}` };
  }
  if (n.archived_at) return { skip: "archived", detail: "the note is archived; restore it first" };
  const who = others([
    ...hist.filter((e) => e.version > first.version).map((e) => e.saved_by),
    n.written_by,
    ...dropped.filter((d) => d.last_at >= first.saved_at).map((d) => d.saved_by),
  ]);
  return { action: "restore", version: first.version, ...(who.length ? { conflict: `changed later by ${who.map((w) => `"${safe(w, 40)}"`).join(", ")}` } : {}) };
}

function planHash(p: RollbackPlan): string {
  return createHash("sha256")
    .update(JSON.stringify(p.actions.map((a) => [a.id, a.rev, a.action, a.restore_version ?? 0])))
    .digest("hex")
    .slice(0, 32);
}

function gate(caller: Caller): string[] | undefined {
  if (!scopeAllows(caller.scope, "admin")) throw new SupersedeError("rolling back a writer is for administrators", 403);
  return caller.ownNamespace !== undefined ? [caller.ownNamespace] : undefined;
}

function previewText(p: RollbackPlan, ttl: number, how: string): string {
  const line = (x: { id: number; namespace: string; title: string; pinned?: true }): string =>
    `note ${x.id} [${safe(x.namespace, 40)}] "${safe(x.title, 80)}"${x.pinned ? " (PINNED)" : ""}`;
  const list = <T,>(rows: T[], f: (r: T) => string): string[] => [
    ...rows.slice(0, TEXT_LIST_MAX).map((r) => "  - " + f(r)),
    ...(rows.length > TEXT_LIST_MAX ? [`  ... and ${rows.length - TEXT_LIST_MAX} more (see the JSON)`] : []),
  ];
  const arch = p.actions.filter((a) => a.action === "archive");
  const rest = p.actions.filter((a) => a.action === "restore");
  const out = [`Roll back everything "${safe(p.writer, 60)}" did since ${p.since}${stdioFamily(p.writer) ? " (every stdio:<app> too)" : ""}:`];
  if (p.actions.length === 0) out.push("Nothing to do.");
  if (arch.length) out.push(`Archive ${arch.length} note(s) it created:`, ...list(arch, (a) => line(a) + (a.conflict ? " (others changed it too)" : "")));
  if (rest.length) out.push(`Put back the earlier text of ${rest.length} note(s) it changed:`, ...list(rest, (a) => `${line(a)} -> version ${a.restore_version}${a.conflict ? " (overwrites later changes by others)" : ""}`));
  if (p.skipped.length) out.push(`Skipped ${p.skipped.length} note(s):`, ...list(p.skipped, (s) => `${line(s)}: ${s.reason.replace(/_/g, " ")}, ${s.detail}`));
  out.push(
    "Nothing is deleted: archived notes come back with `monomem restore <id>`, and each restored note keeps the text it replaces in its history " +
      "(`monomem history restore <id> <version>` undoes it).",
    `This code works once, for ${Math.round(ttl / 60)} minute(s). ${how}`
  );
  return out.join("\n");
}

/** Step 1. Reads only. */
export function rollbackPreview(
  store: Store,
  caller: Caller,
  req: { writer: unknown; since: unknown; include_conflicts?: unknown },
  howToConfirm = "To go ahead, confirm with this code: {token}"
): RollbackPreview {
  const namespaces = gate(caller);
  const writer = parseWriter(req.writer);
  const since = parseSince(req.since);
  const plan = planRollback(store, writer, since, req.include_conflicts === true, namespaces);
  const ttl = supersedeTtlSeconds();
  const expMs = Date.now() + ttl * 1000;
  const token = store.mintToken(TOKEN_DOMAIN, {
    w: writer,
    s: since,
    c: plan.include_conflicts ? 1 : 0,
    h: planHash(plan),
    k: callerKey(caller),
    e: expMs,
    x: randomBytes(12).toString("hex"),
  });
  return {
    ok: true,
    ...plan,
    warning: previewText(plan, ttl, howToConfirm.replace("{token}", token)),
    token,
    expires_at: new Date(expMs).toISOString(),
    expires_in_seconds: ttl,
  };
}

export interface RollbackResult {
  ok: true;
  message: string;
  archived: number[];
  restored: Array<{ id: number; version: number; now_rev: number }>;
  skipped: RollbackSkip[];
}

/** Recompute the embeddings of the notes a rollback restored (their text changed). Best effort, like every write path. */
export async function embedRestored(store: Store, out: RollbackResult): Promise<void> {
  for (const r of out.restored) {
    const n = store.read(r.id); // gate-ok: re-embed what the operator just restored; nothing is returned
    if (n) await maybeEmbed(store, n);
  }
}

/** Step 2. Needs a valid, unexpired, unused code made for this caller; applies the previewed plan atomically or nothing. */
export function rollbackConfirm(store: Store, caller: Caller, req: { token: unknown }): RollbackResult {
  const namespaces = gate(caller);
  if (typeof req.token !== "string" || !req.token) throw new SupersedeError("a confirmation code from the preview is required");
  const t = store.openToken(TOKEN_DOMAIN, req.token);
  if (!t || t.k !== callerKey(caller)) throw new SupersedeError("that is not a valid confirmation code (it may have been copied wrongly); run the preview again");
  const exp = Number(t.e);
  if (!Number.isFinite(exp) || Date.now() > exp) throw new SupersedeError("that confirmation code has expired; run the preview again", 410);
  const nonce = String(t.x ?? "");
  if (!/^[0-9a-f]{24}$/.test(nonce)) throw new SupersedeError("that is not a valid confirmation code; run the preview again");
  if (store.tokenSpent(nonce)) throw new SupersedeError("that confirmation code was already used; run the preview again", 410);
  const writer = String(t.w);
  const since = String(t.s);

  const out = store.transaction(() => {
    store.spendNonce(nonce, exp);
    const plan = planRollback(store, writer, since, Number(t.c) === 1, namespaces);
    if (planHash(plan) !== t.h) throw new StaleWriteError("notes changed since the preview; nothing was changed. Run the preview again");
    const archived: number[] = [];
    const restored: RollbackResult["restored"] = [];
    for (const a of plan.actions) {
      if (a.action === "archive") {
        store.archive(a.id);
        archived.push(a.id);
      } else {
        const back = store.restoreVersion(a.id, a.restore_version as number, { ifRev: a.rev, reason: "rollback", noFloodCount: true });
        if (!back) throw new StaleWriteError(`note ${a.id} is gone; nothing was changed`);
        restored.push({ id: a.id, version: a.restore_version as number, now_rev: back.rev });
      }
    }
    return { archived, restored, skipped: plan.skipped };
  });
  audit({ op: "rollback", label: writer, detail: `since ${since}: archived ${out.archived.length}, restored ${out.restored.length}, skipped ${out.skipped.length}` });
  const message =
    `Rolled back "${safe(writer, 60)}" since ${since}: archived ${out.archived.length}, restored ${out.restored.length}, skipped ${out.skipped.length}. ` +
    "Undo: `monomem restore <id>` for an archived note, `monomem history restore <id> <version>` for a restored one.";
  return { ok: true, message, ...out };
}
