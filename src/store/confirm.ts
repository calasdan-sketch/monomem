// Confirms and re-confirmation expiry (1.5.0 store split, moved out of store.ts): the unconfirmed backlog, confirm settings,
// expired notes, the review list, confirm() and its refusal rules, and rollback candidates. Free functions over the Store;
// Store keeps a one-line delegate for each, and the caches (confirmCache) stay on Store. Imports `type { Store }` only.

import type { ConfirmResult, ConfirmSettings, NoteRecord, ReviewItem, ReviewRow, Store } from "../store.js";
import { actorStore, currentCeiling, currentWriter } from "../actor.js";
import { taintWindowHours } from "../config.js";
import { ValidationError } from "../errors.js";
import { CONFIRM_MODES, DEFAULT_CONFIRM_DAYS, MAX_CONFIRM_DAYS, ORIGIN_PREFIX, ORIGIN_TOOL_PREFIX, ORIGIN_VIA_MEMORY, isTainted, promotionRefusal, sourceKey, type ConfirmMode } from "../taint.js";
import { NOTE_COLUMNS, nameIsSql } from "../trust.js";
import { CONFIRM_RANK, dueBase, needsHumanConfirm, parseTags, rankSql, type DueRow } from "./rows.js";

export function unconfirmedCount(s: Store, namespaces?: string[]): number {
  return s.unconfirmedRows(namespaces).length;
}

export function unconfirmedBreakdown(s: Store, namespaces?: string[]): { tool: number; via: number; declared: number } {
  const out = { tool: 0, via: 0, declared: 0 };
  for (const r of s.unconfirmedRows(namespaces)) {
    const t = parseTags(r.tags);
    if (t.some((x) => x.startsWith(ORIGIN_TOOL_PREFIX))) out.tool++;
    else if (t.includes(ORIGIN_VIA_MEMORY)) out.via++;
    else out.declared++;
  }
  return out;
}

export function confirmBacklog(s: Store): { count: number; oldest_days: number; capped: boolean; reason: string } {
  const rows = s.unconfirmedRows();
  const oldest = rows.reduce((m, r) => Math.min(m, Date.parse(r.updated_at) || Date.now()), Date.now());
  const days = Math.floor((Date.now() - oldest) / 86_400_000);
  const many = rows.length >= 10;
  const old = rows.length > 0 && days > 7;
  return { count: rows.length, oldest_days: days, capped: many || old, reason: many ? `${rows.length} unconfirmed notes wait for review` : old ? `the oldest unconfirmed note has waited ${days} days` : "" };
}

export function unconfirmedRows(s: Store, namespaces?: string[]): ReviewRow[] {
  if (namespaces && namespaces.length === 0) return [];
  const ver = s.db.prepare("SELECT total_changes() AS t").get() as { t: number };
  const dv = s.db.prepare("PRAGMA data_version").get() as { data_version: number };
  // Read bookkeeping (access counts, the access log, the flood counter) moves total_changes() but no note: not counted.
  const key = JSON.stringify([namespaces ?? null, ver.t - s.bookkeepingChanges, dv.data_version, currentCeiling() ?? null]);
  if (s.unconfirmedCache?.key === key) return s.unconfirmedCache.rows;
  const rows = s.scanUnconfirmed(namespaces);
  s.unconfirmedCache = { key, rows };
  return rows;
}

/** The unconfirmed scan's SQL and parameters (also read by test/query-plans.test.ts to check the plan). */
export function unconfirmedSql(s: Store, namespaces?: string[]): { sql: string; params: Array<string | number> } {
  const ns = namespaces ? ` AND namespace IN (${namespaces.map(() => "?").join(",")})` : "";
  const dis = s.distrustFragment(NOTE_COLUMNS, namespaces);
  return {
    // INDEXED BY: left to itself the planner prefers idx_notes_archived (every live note); the partial index holds only the stamped ones.
    sql: `SELECT id, namespace, title, written_by, tags, updated_at FROM notes INDEXED BY idx_notes_origin WHERE archived_at IS NULL AND grandfathered_at IS NULL AND tags LIKE '%obs.origin:%'
         AND NOT (confirmed_kind IS NOT NULL AND confirmed_rev = rev)${ns}${s.ceilingSql()}${dis.sql} ORDER BY id`,
    params: [...(namespaces ?? []), ...dis.params] as Array<string | number>,
  };
}

export function scanUnconfirmed(s: Store, namespaces?: string[]): ReviewRow[] {
  const { sql, params } = s.unconfirmedSql(namespaces);
  const rows = s.db.prepare(sql).all(...params) as unknown as ReviewRow[];
  return rows.filter((r) => isTainted(parseTags(r.tags)));
}

export function confirmSettings(s: Store): ConfirmSettings {
  const now = Date.now();
  if (s.confirmCache && now - s.confirmCache.at < 1000) return s.confirmCache.v;
  const m = s.getMeta("confirm_mode");
  const d = Number(s.getMeta("confirm_days"));
  const setAt = s.getMeta("confirm_mode_set_at");
  const v: ConfirmSettings = {
    // A3: unset = the default (label); set but unknown = damaged, so the strictest mode (enforce).
    mode: m === null ? "label" : (CONFIRM_MODES as readonly string[]).includes(m) ? (m as ConfirmMode) : "enforce",
    days: Number.isInteger(d) && d >= 1 && d <= MAX_CONFIRM_DAYS ? d : DEFAULT_CONFIRM_DAYS,
    ...(setAt ? { set_at: setAt } : {}),
  };
  s.confirmCache = { at: now, v };
  return v;
}

export function setConfirmSettings(s: Store, next: { mode?: ConfirmMode; days?: number }): ConfirmSettings {
  if (next.mode !== undefined && !CONFIRM_MODES.includes(next.mode)) throw new ValidationError(`confirm-mode must be one of: ${CONFIRM_MODES.join(", ")}`);
  if (next.days !== undefined && !(Number.isInteger(next.days) && next.days >= 1 && next.days <= MAX_CONFIRM_DAYS)) {
    throw new ValidationError(`confirm-days must be a whole number from 1 to ${MAX_CONFIRM_DAYS}`);
  }
  const before = s.confirmSettings();
  // Shortening the period while enforce is on would hide notes at once; like turning expiry on, it restarts the clock.
  // label <-> enforce keeps every due date: switching between the two never restarts a note's clock.
  const shrinksUnderEnforce = next.days !== undefined && next.days < before.days && (next.mode ?? before.mode) === "enforce";
  s.transaction(() => {
    if (next.days !== undefined) s.setMeta("confirm_days", String(next.days));
    if (next.mode !== undefined && next.mode !== before.mode) s.setMeta("confirm_mode", next.mode);
    const turnsOn = next.mode !== undefined && next.mode !== before.mode && before.mode === "off";
    if (turnsOn || shrinksUnderEnforce) s.setMeta("confirm_mode_set_at", new Date().toISOString());
  });
  s.confirmCache = null;
  const after = s.confirmSettings();
  s.audit({ op: "confirm-settings", detail: `mode ${after.mode}, days ${after.days}` });
  return after;
}

/** Live ordinary notes past their re-confirmation date (none when the mode is off). Pinned notes are exempt. */
export function expiredRows(s: Store, namespaces?: string[]): ReviewRow[] {
  const c = s.confirmSettings();
  if (c.mode === "off" || (namespaces && namespaces.length === 0)) return [];
  const ns = namespaces ? ` AND namespace IN (${namespaces.map(() => "?").join(",")})` : "";
  const dis = s.distrustFragment(NOTE_COLUMNS, namespaces);
  const cutoff = Date.now() - c.days * 86_400_000;
  // 1.5.0: the clock's start (the same formula as dueBase) is computed in SQL, so only notes that are probably due come back, not
  // every old note. A day of slack because SQLite and Date.parse may read an odd timestamp a little differently; dueBase()
  // then decides exactly in JS.
  const loose = new Date(cutoff + 86_400_000).toISOString();
  const setAtMs = c.set_at ? Date.parse(c.set_at) : NaN;
  const setAtDay = Number.isNaN(setAtMs) ? 0 : 2440587.5 + setAtMs / 86_400_000;
  const rows = s.db
    .prepare(
      `SELECT id, namespace, title, written_by, tags, updated_at, content_at, confirmed_at, confirmed_kind, confirmed_rev, rev, grandfathered_at FROM notes
        WHERE archived_at IS NULL AND superseded_by IS NULL AND COALESCE(pinned, 0) = 0 AND COALESCE(kind, 'note') = 'note'
          AND tags NOT LIKE '%"task"%' AND tags NOT LIKE '%"handoff"%'
          AND MAX(COALESCE(julianday(COALESCE(content_at, updated_at)), 0),
                  CASE WHEN confirmed_kind IN ('human', 'admin') AND confirmed_rev = rev THEN COALESCE(julianday(confirmed_at), 0) ELSE 0 END,
                  COALESCE(julianday(grandfathered_at), 0), ?) <= julianday(?)${ns}${s.ceilingSql()}${dis.sql} ORDER BY id`
    )
    .all(setAtDay, loose, ...(namespaces ?? []), ...dis.params) as unknown as Array<ReviewRow & DueRow>;
  return rows.filter((r) => {
    const base = dueBase(r, c);
    return base > 0 && base <= cutoff;
  });
}

export function expiredCount(s: Store, namespaces?: string[]): number {
  return s.expiredRows(namespaces).length;
}

export function reviewList(s: Store, namespaces?: string[]): ReviewItem[] {
  const days = s.confirmSettings().days;
  const out = new Map<number, ReviewItem>();
  const add = (r: ReviewRow, why: string): void => {
    const cur = out.get(r.id);
    if (cur) out.set(r.id, { ...cur, why: `${cur.why}; ${why}` });
    else out.set(r.id, { id: Number(r.id), namespace: r.namespace, title: r.title, writer: r.written_by ?? "", why });
  };
  for (const r of s.unconfirmedRows(namespaces)) {
    const origins = parseTags(r.tags).filter((t) => t.startsWith(ORIGIN_PREFIX)).map((t) => t.slice(ORIGIN_PREFIX.length));
    add(r, `unconfirmed: from outside content (${origins.join(", ")}), nobody confirmed this version`);
  }
  for (const r of s.expiredRows(namespaces)) add(r, `expired: not re-confirmed in ${days} days (last changed ${r.updated_at.slice(0, 10)})`);
  return [...out.values()].sort((a, b) => a.id - b.id);
}

export function confirmRuleLines(s: Store): string[] {
  const c = s.confirmSettings();
  const unconfirmed = s.unconfirmedCount();
  const expired = s.expiredCount();
  const hours = taintWindowHours();
  const plural = (n: number): string => `${n} note${n === 1 ? "" : "s"}`;
  const b = s.unconfirmedBreakdown();
  const back = s.confirmBacklog();
  const wins = s.openWindows();
  return [
    `Unconfirmed notes (from outside content, kept out of session start until confirmed): ${unconfirmed}${unconfirmed ? " (monomem review)" : ""}`,
    ...(unconfirmed ? [`By origin: ${b.tool} written during a session that read the web, ${b.via} after reading unconfirmed notes, ${b.declared} declared by the writer`] : []),
    ...(wins.length ? [`Open outside-content windows: ${wins.map((w) => `${w.cwd || "(unknown folder)"} (${w.tools.join(", ") || "other"}, ${w.minutes} min ago)`).join("; ")} (end them: monomem settings outside-window clear)`] : []),
    ...(back.capped ? [`The health grade is capped at B: ${back.reason}. Review them: monomem review`] : []),
    c.mode === "off"
      ? "Re-confirmation expiry: off (no note expires; turn on: monomem settings set confirm-mode label)"
      : `Re-confirmation expiry: ${c.mode}, every ${c.days} days; ${plural(expired)} past due (${c.mode === "enforce" ? "kept out of session start" : "labelled in search, still shown"})`,
    hours > 0
      ? `Outside-content window: notes written by a local app (no key of its own) launched in the same folder as a hooked session that read outside content, within ${hours} hours and while that session is active (idle 30 minutes ends it), are marked; apps with their own key are not (MONOMEM_TAINT_WINDOW_HOURS)`
      : "Outside-content window: off (MONOMEM_TAINT_WINDOW_HOURS=0), so hooked sessions' outside reads mark nothing",
    "Reading unconfirmed notes marks later writes: when an app reads a note nobody has confirmed, what it writes next is marked too, until that note is confirmed or the outside-content window passes. This is counted per connection and starts over when the server restarts.",
  ];
}

export function requireHumanConfirm(s: Store, id: number, verb: string): void {
  const n = s.read(id);
  if (!n || !needsHumanConfirm(n)) return;
  if (currentWriter() === "cli") {
    s.confirm(id, { source: `operator: ${verb}` });
    return;
  }
  throw new ValidationError(promotionRefusal(verb, id, n.confirmed_kind === "admin" && n.confirmed_rev === n.rev));
}

export function confirm(s: Store, id: number, opts: { source?: string; admin?: boolean; dashboard?: boolean } = {}): ConfirmResult | null {
  const n = s.readVisible(id, { hideArchived: true }); // gate-ok: a hidden note answers like a missing one (null)
  if (!n) return null;
  const w = currentWriter();
  const human = w === "cli";
  if (!human) s.floodGate("full");
  const source = (opts.source ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const key = source ? sourceKey(source) : "";
  const at = new Date().toISOString();
  const base = { id, title: n.title, rev: n.rev, by: w, at, source };
  // R1-03: the rules (`already`, `same_source`, ...) and the kind are decided INSIDE the write transaction (BEGIN IMMEDIATE), so
  // two processes cannot both read "nothing yet" and both count.
  const st: { refusal: { code: string; message: string } | null; kind: ConfirmResult["kind"]; stored: boolean; kept: { at: string; kind: string } | null } = {
    refusal: null,
    kind: "not_counted",
    stored: false, // this confirm became the note's confirm
    kept: null, // a stronger confirm of this version stays (this one is recorded)
  };
  const write = (): void => {
    const refusal = s.confirmRefusal(n, w, human, opts.admin === true, key, opts.admin === true && opts.dashboard === true);
    st.refusal = refusal;
    if (refusal?.code === "already") return;
    const kind: ConfirmResult["kind"] = refusal ? "not_counted" : human ? "human" : opts.admin ? "admin" : "corroborated";
    st.kind = kind;
    s.db
      .prepare("INSERT INTO confirmations (note_id, note_rev, at, by, by_authed, kind, source, source_key, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, n.rev, at, w, actorStore.getStore()?.authed ? 1 : 0, kind, source, key, refusal?.code ?? "");
    if (refusal) return;
    // Only a confirm at least as strong as the note's current one (for this rev) replaces it and restarts the
    // re-confirmation clock: an agent's corroboration never refreshes a person's or an admin's confirm. Decided inside
    // the UPDATE, so two processes cannot let a weaker kind overwrite a stronger one. `rev = ?`: the version read.
    const res = s.db
      .prepare(
        `UPDATE notes SET confirmed_at = ?, confirmed_rev = rev, confirmed_kind = ?, confirmed_by = ?
         WHERE id = ? AND rev = ? AND NOT (confirmed_rev = rev AND ${rankSql("confirmed_kind")} > ?)`
      )
      .run(at, kind, w, id, n.rev, CONFIRM_RANK[kind]);
    st.stored = Number(res.changes) > 0;
    if (!st.stored) {
      const cur = s.db.prepare("SELECT rev, confirmed_at, confirmed_kind FROM notes WHERE id = ?").get(id) as { rev: number; confirmed_at: string; confirmed_kind: string } | undefined;
      if (cur && Number(cur.rev) === n.rev) st.kept = { at: cur.confirmed_at, kind: cur.confirmed_kind };
    }
  };
  // Inside a caller's transaction (a CLI supersede's commit) the rows ride on it.
  if (s.db.isTransaction) write();
  else s.transaction(write);
  const { refusal, kind, stored, kept } = st;
  if (refusal?.code === "already") return { ...base, counted: false, recorded: false, kind: "not_counted", reason: refusal.code, message: refusal.message };
  s.audit({ op: refusal ? "confirm-not-counted" : "confirm", id, namespace: n.namespace, detail: refusal ? refusal.code : kind });
  if (!refusal && !stored && !kept) {
    const message = `Not counted: note ${id} changed while it was being confirmed. Read it again and confirm the new version.`;
    return { ...base, counted: false, recorded: true, kind: "not_counted", reason: "changed", message };
  }
  const checked = source ? ` Checked against: ${source}.` : "";
  const cs = s.confirmSettings();
  // The due date is the one stored: this confirm's, or the stronger one the note keeps.
  const dueAt = kept ? Date.parse((kept as { at: string }).at) + cs.days * 86_400_000 : Date.parse(at) + cs.days * 86_400_000;
  const dueDay = new Date(dueAt).toISOString().slice(0, 10);
  const keptKind = kept ? (kept as { kind: string }).kind : "";
  const weakOnly = !refusal && (stored ? kind === "corroborated" : keptKind === "corroborated");
  const due =
    weakOnly
      ? " This releases the session-start hold. It does not restart the re-confirmation clock: a person or an admin must confirm for that."
      : cs.mode === "off" ? "" : dueAt <= Date.now() ? ` It is past its re-confirmation date (${dueDay}): a person or an admin must confirm it again.` : ` Next check due ${dueDay}.`;
  // Only the person at the terminal sees the title echoed: to an agent a title is outside text it did not ask to read.
  const what = human ? `"${n.title.slice(0, 80)}"` : `note #${id}`;
  const keptNote = kept ? ` The note keeps its stronger ${(kept as { kind: string }).kind} confirm; this one is recorded but does not restart its clock.` : "";
  const message = refusal ? refusal.message : `Confirmed ${what} by ${w || "(unknown)"} at ${at.slice(0, 16).replace("T", " ")}.${checked}${keptNote}${due}`;
  return { ...base, counted: !refusal, recorded: true, kind, ...(refusal ? { reason: refusal.code } : {}), message };
}

/** Why a confirm does not count (null = it counts). Plain words, naming the rule. */
export function confirmRefusal(s: Store, n: NoteRecord, w: string, human: boolean, admin: boolean, key: string, dashboard = false): { code: string; message: string } | null {
  const who = w || "an unidentified writer";
  // With expiry on, a confirm older than the expiry period no longer blocks a new one: re-confirming is the point.
  const c = s.confirmSettings();
  const since = c.mode === "off" ? "" : new Date(Date.now() - c.days * 86_400_000).toISOString();
  const again = s.db
    .prepare("SELECT 1 FROM confirmations WHERE note_id = ? AND note_rev = ? AND by = ? AND reason = '' AND at > ? LIMIT 1")
    .get(n.id, n.rev, w, since);
  if (again) return { code: "already", message: `Not counted again: ${who} already confirmed this version of the note. One confirm per writer per version.` };
  if (human) return null;
  const own = [n.written_by, n.created_by, n.attested_writer ?? "", ...(n.merged_from_writers ?? [])].filter(Boolean);
  if (w && own.includes(w)) return { code: "same_writer", message: `Not counted: ${who} wrote this note, so it can't confirm it. A person or a different agent must confirm.` };
  const actor = actorStore.getStore();
  if (!actor?.authed || w === "" || w === "stdio" || w.startsWith("stdio:")) {
    return { code: "unauthenticated", message: `Not counted: ${who} is a local connection without its own key, so its name is a claim, not an identity. The confirm is recorded but does not count. A person (monomem confirm ${n.id}) or an agent with its own key must confirm.` };
  }
  if (s.isDistrusted({ namespace: n.namespace, written_by: w })) return { code: "distrusted", message: `Not counted: ${who} is on the distrust list for this namespace.` };
  // The dashboard (a session opened with monomem open; it lists the note to show the button) skips this rule: a person
  // is looking at the note, and an admin confirm only releases the session-start hold, never promotion. Any other key,
  // admin or not, that was handed the note while unconfirmed is refused: REST cannot tell a person from an agent.
  if (!dashboard && actor.taintedReads?.has(n.id)) {
    return { code: "read_it", message: `Not counted: ${who} read this note's text while it was unconfirmed, so the confirm could be the note talking. A person or an agent that has not read it must confirm.` };
  }
  const derived = s.db
    .prepare("SELECT 1 FROM note_links l JOIN notes c ON c.id = l.note_id WHERE l.derived_from = ? AND (c.written_by = ? OR c.created_by = ?) LIMIT 1")
    .get(n.id, w, w);
  if (derived) return { code: "derived", message: `Not counted: ${who} wrote a note built from this one, so it can't confirm it.` };
  if (admin) return null;
  if (!key) return { code: "no_source", message: "Not counted: an agent's confirm must name the source it checked the note against (source)." };
  // Bounded like "already": after the expiry period an earlier confirm's source may be named again.
  const used = s.db.prepare("SELECT source_key FROM confirmations WHERE note_id = ? AND note_rev = ? AND reason = '' AND at > ?").all(n.id, n.rev, since) as Array<{ source_key: string }>;
  if ((n.source && sourceKey(n.source) === key) || used.some((u) => u.source_key === key)) {
    return { code: "same_source", message: "Not counted: that source is the note's own, or one an earlier confirm already named. Name a different source." };
  }
  return null;
}

export function rollbackCandidates(s: Store, writer: string, family: boolean, sinceIso: string, namespaces?: string[]): number[] {
  if (namespaces && namespaces.length === 0) return [];
  const m = (col: string) => nameIsSql(col, writer, family);
  const [c, w, h, d] = [m("created_by"), m("written_by"), m("h.saved_by"), m("d.saved_by")];
  const nsSql = namespaces ? ` AND namespace IN (${namespaces.map(() => "?").join(",")})` : "";
  const rows = s.db
    .prepare(
      `SELECT id FROM notes WHERE ((${c.sql} AND created_at >= ?) OR (${w.sql} AND updated_at >= ?)
         OR id IN (SELECT h.note_id FROM note_history h WHERE ${h.sql} AND h.saved_at >= ?)
         OR id IN (SELECT d.note_id FROM note_history_dropped d WHERE ${d.sql} AND d.last_at >= ?))${nsSql}${s.ceilingSql()}
       ORDER BY id`
    )
    .all(...c.params, sinceIso, ...w.params, sinceIso, ...h.params, sinceIso, ...d.params, sinceIso, ...(namespaces ?? [])) as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}
