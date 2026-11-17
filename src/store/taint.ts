// Outside-content taint for writes (1.5.0 store split, moved out of store.ts): which obs.origin tags a write gets, read-taint,
// the hook session windows and retro-taint. Free functions over the Store; Store keeps a one-line delegate for each.
// Imports `type { Store }` only, so this module is in no import cycle (test/import-cycles.test.ts).

import type { Store } from "../store.js";
import { actorStore } from "../actor.js";
import { taintWindowHours } from "../config.js";
import { ValidationError } from "../errors.js";
import { MAX_DERIVED_FROM, ORIGIN_DECLARED, ORIGIN_PREFIX, ORIGIN_VIA_MEMORY, isOutsideTool, isTainted, sameFolder, sessionTaintExempt, toolTag } from "../taint.js";
import { SESSION_IDLE_MS, parseTags, tagsToStorage } from "./rows.js";
import { cosineOfFreq, termFreq, tokenize } from "../text-sim.js";
import { recordBranch } from "../git-trail.js";

/**
 * The `obs.origin:*` tags a write gets: `outside: true` (declared), the connection's own (ActorRef.taint: a reads_outside
 * token), read-taint (via:memory, while a note this connection read is still unconfirmed and was read within the taint window)
 * and the hook session signal. `writer` null = an internal write for someone else (only `declared`).
 * 1.5.0: taint follows the ACTOR. The hook window stamps only local unauthenticated writers (stdio, a non-terminal cli), matched
 * by the writer process's folder, never by the namespace the write names; a token writer gets only its own signals.
 */
export function taintFor(s: Store, declared: boolean | undefined, writer: string | null): string[] {
  const out = new Set<string>(declared === true ? [ORIGIN_DECLARED] : []);
  if (writer === null) return [...out];
  const actor = actorStore.getStore();
  for (const t of actor?.taint ?? []) if (t.startsWith(ORIGIN_PREFIX)) out.add(t);
  if (s.readTaintLive(actor?.taintedReads)) out.add(ORIGIN_VIA_MEMORY);
  if (actor?.authed !== true && !sessionTaintExempt(writer)) for (const t of s.sessionOutsideTags(actor?.cwd)) out.add(t);
  return [...out];
}

/** Read-taint: some note this connection read within the taint window is still unconfirmed now. */
export function readTaintLive(s: Store, reads: ReadonlyMap<number, number> | undefined): boolean {
  if (!reads || reads.size === 0) return false;
  const h = taintWindowHours();
  const cutoff = Date.now() - (h > 0 ? h : 12) * 3_600_000;
  const q = s.db.prepare("SELECT tags, grandfathered_at, confirmed_kind, confirmed_rev, rev FROM notes WHERE id = ?");
  for (const [id, at] of reads) {
    if (at < cutoff) continue;
    const r = q.get(id) as { tags: string; grandfathered_at: string | null; confirmed_kind: string | null; confirmed_rev: number | null; rev: number } | undefined;
    if (r && isTainted(parseTags(r.tags)) && r.grandfathered_at === null && !(r.confirmed_kind && Number(r.confirmed_rev) === Number(r.rev))) return true;
  }
  return false;
}

/**
 * 1.4.0 (1d): a write's `derived_from`, checked: a list of at most MAX_DERIVED_FROM note ids (numbers or digit strings),
 * each an existing note the caller may see, never the note itself. Duplicates collapse. Absent = [].
 * "May see" = the caller's read rules: its namespaces (ActorRef.readable, when its server confines it), the distrust list
 * and its sensitivity ceiling. Anything else answers exactly like a missing id, so a link is no probe.
 */
export function derivedIds(s: Store, list: unknown, self?: number): number[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ValidationError("derived_from must be a list of note ids");
  if (list.length > MAX_DERIVED_FROM) throw new ValidationError(`derived_from: at most ${MAX_DERIVED_FROM} notes`);
  const ids = list.map((v) => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d{1,15}\s*$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < 1) throw new ValidationError(`derived_from: ${JSON.stringify(String(v).slice(0, 40))} is not a note id`);
    return n;
  });
  const uniq = [...new Set(ids)];
  const readable = actorStore.getStore()?.readable;
  for (const id of uniq) {
    if (id === self) throw new ValidationError("derived_from: a note cannot be built from itself");
    const n = s.readVisible(id); // gate-ok: existence check only, nothing of the parent is returned
    if (!n || (readable && !readable.includes(n.namespace))) throw new ValidationError(`derived_from: no note with id ${id}`);
  }
  return uniq;
}

/** A note built from an unconfirmed note is marked as written after reading unconfirmed memory. `parents` passed derivedIds (readable only). */
export function inheritedTaint(s: Store, parents: number[]): string[] {
  return parents.some((p) => s.read(p)?.unconfirmed === true) ? [ORIGIN_VIA_MEMORY] : [];
}

/** Add-only: links are inserted, never deleted or replaced. Runs inside the caller's write transaction. */
/**
 * A content write by the local CLI records whether it ran at a terminal (notes.cli_tty), so a spooled outside read marked
 * later (retroTaint) can tell the person's write from the same command run by an agent's shell.
 */
export function stampCliTerminal(s: Store, id: number, writer: string): void {
  if (writer === "cli") s.db.prepare("UPDATE notes SET cli_tty = ? WHERE id = ?").run(sessionTaintExempt("cli") ? 1 : 0, id);
  // 1.5.0: the folder of the local server that wrote this content (NULL = another kind of writer, or unknown origin).
  const actor = actorStore.getStore();
  const cwd = actor?.authed !== true && (writer === "stdio" || writer.startsWith("stdio:")) && actor?.cwd ? actor.cwd : null;
  s.db.prepare("UPDATE notes SET writer_cwd = ? WHERE id = ?").run(cwd, id);
  // PLAN I: and the git repository and branch that folder is on (note_branches side table; branch-scoped session start).
  recordBranch(s.db, id, cwd);
}

export function addLinks(s: Store, id: number, parents: number[], by: string, at: string): void {
  const ins = s.db.prepare("INSERT OR IGNORE INTO note_links (note_id, derived_from, added_at, added_by) VALUES (?, ?, ?, ?)");
  for (const p of parents) ins.run(id, p, at, by);
  if (parents.length) s.linksSeen = { any: true, at: Date.now() };
}

/**
 * Sessions a hook has seen recently: not ended, last capture event (or start) within SESSION_IDLE_MS, so a crashed or idle
 * session stops counting at once instead of after distillStaleSessions has run.
 */
export function activeSessions(s: Store): Array<{ id: string; cwd: string; outside_at: string | null }> {
  const idle = new Date(Date.now() - SESSION_IDLE_MS).toISOString();
  return s.db
    .prepare(
      `SELECT s.id, s.cwd, s.outside_at FROM sessions s WHERE s.ended_at IS NULL
         AND COALESCE((SELECT MAX(at) FROM capture_events e WHERE e.session_id = s.id), s.started_at) >= ?`
    )
    .all(idle) as Array<{ id: string; cwd: string; outside_at: string | null }>;
}

/** Sessions whose outside window applies to a writer launched in `cwd` (undefined = unknown origin: every open window). */
export function windowSessions(s: Store, cwd: string | undefined): Array<{ id: string; cwd: string; outside_at: string }> {
  const hours = taintWindowHours();
  if (hours <= 0) return [];
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  const active = s.activeSessions();
  const mine = cwd ? active.filter((x) => sameFolder(x.cwd, cwd)) : [];
  // A folder that matches no active session is an unknown origin (Claude Desktop, a server an agent launched from a shell).
  return (mine.length ? mine : active).filter((x): x is { id: string; cwd: string; outside_at: string } => x.outside_at !== null && x.outside_at >= cutoff);
}

/**
 * The hook signal (R1-04): the stamps for a local writer launched in `cwd` while a session of that folder read outside content
 * within the taint window. Returns the tools' stamps (at most 3), or `...:other`. Cached 1 s per folder (the lookup runs on
 * every agent write); MONOMEM_SCAN_CACHE_SECONDS=0 turns that off for tests.
 */
export function sessionOutsideTags(s: Store, cwd: string | undefined): string[] {
  const ttl = Math.min(1000, Math.max(0, Number(process.env.MONOMEM_SCAN_CACHE_SECONDS ?? "60") || 0) * 1000);
  const key = cwd ?? "";
  const hit = s.windowCache.get(key);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.tags;
  const tags = s.computeWindowTags(cwd);
  s.windowCache.set(key, { at: Date.now(), tags });
  return tags;
}

export function windowTools(s: Store, ids: string[], cutoff: string): string[] {
  if (!ids.length) return [];
  const tools = s.db
    .prepare(`SELECT DISTINCT tool FROM capture_events WHERE session_id IN (${ids.map(() => "?").join(",")}) AND event IN ('post-tool', 'post-tool-failure') AND at >= ?`)
    .all(...ids, cutoff) as Array<{ tool: string }>;
  return tools.map((r) => r.tool).filter((t) => isOutsideTool(t));
}

export function computeWindowTags(s: Store, cwd: string | undefined): string[] {
  const sessions = s.windowSessions(cwd);
  if (!sessions.length) return [];
  const cutoff = new Date(Date.now() - taintWindowHours() * 3_600_000).toISOString();
  const tags = [...new Set(s.windowTools(sessions.map((x) => x.id), cutoff).map(toolTag))].sort().slice(0, 3);
  return tags.length ? tags : [toolTag("other")];
}

export function taintClear(s: Store, sel: { all?: boolean; session?: string; cwd?: string }): number {
  const open = s.db.prepare("SELECT id, cwd FROM sessions WHERE ended_at IS NULL AND outside_at IS NOT NULL").all() as Array<{ id: string; cwd: string }>;
  const ids = open.filter((x) => sel.all === true || (sel.session !== undefined && x.id === sel.session) || (sel.cwd !== undefined && sameFolder(x.cwd, sel.cwd))).map((x) => x.id);
  if (ids.length) s.transaction(() => s.db.prepare(`UPDATE sessions SET outside_at = NULL WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids));
  s.windowCache.clear();
  s.audit({ op: "taint-clear", detail: `${ids.length} window(s) closed` });
  return ids.length;
}

export function openWindows(s: Store, cwd?: string): Array<{ cwd: string; tools: string[]; minutes: number }> {
  const hours = taintWindowHours();
  if (hours <= 0) return [];
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows = (cwd === undefined ? s.activeSessions() : s.activeSessions().filter((x) => sameFolder(x.cwd, cwd))).filter(
    (x): x is { id: string; cwd: string; outside_at: string } => x.outside_at !== null && x.outside_at >= cutoff
  );
  return rows.map((r) => ({
    cwd: r.cwd,
    tools: [...new Set(s.windowTools([r.id], cutoff))].sort(),
    minutes: Math.max(0, Math.round((Date.now() - Date.parse(r.outside_at)) / 60_000)),
  }));
}

export function openWindowLines(s: Store, cwd: string): string[] {
  return s.openWindows(cwd).map(
    (w) =>
      `Monomem: a session in this folder read outside content (${w.tools.join(", ") || "other"}) ${w.minutes} min ago; notes written from here are marked until it ends. A person can stop this: monomem settings outside-window clear --here`
  );
}

export function retroTaint(s: Store, cwd: string, atIso: string, tool: string): number {
  const hours = taintWindowHours();
  if (hours <= 0 || !isOutsideTool(tool)) return 0;
  const until = new Date(Date.parse(atIso) + hours * 3_600_000).toISOString();
  const tag = toolTag(tool);
  const rows = s.db
    .prepare("SELECT id, tags, written_by, cli_tty, writer_cwd FROM notes WHERE updated_at >= ? AND updated_at <= ? AND archived_at IS NULL AND COALESCE(kind, 'note') = 'note'")
    .all(atIso, until) as Array<{ id: number; tags: string; written_by: string | null; cli_tty: number | null; writer_cwd: string | null }>;
  const local = (r: { written_by: string | null; cli_tty: number | null }): boolean =>
    r.written_by === "cli" ? Number(r.cli_tty) !== 1 : r.written_by === "stdio" || (r.written_by ?? "").startsWith("stdio:");
  const marks = rows.filter((r) => local(r) && (r.writer_cwd === null || sameFolder(r.writer_cwd, cwd)) && !parseTags(r.tags).includes(tag));
  if (!marks.length) return 0;
  // One transaction; a note it marks is new outside content, so a pre-upgrade (grandfathered) note loses its exemption.
  s.transaction(() => {
    // 1.5.0 (R1-15): rev and updated_at move so the change feed, sync and embeddings see the new stamp, and a writer holding the
    // old rev gets the normal stale-write answer. content_at stays (expiry unaffected); a confirm that was current carries over.
    const up = s.db.prepare("UPDATE notes SET tags = ?, grandfathered_at = NULL, rev = rev + 1, updated_at = ?, confirmed_rev = CASE WHEN confirmed_rev = rev THEN rev + 1 ELSE confirmed_rev END WHERE id = ?");
    const now = new Date().toISOString();
    for (const r of marks) up.run(tagsToStorage([...parseTags(r.tags), tag]), now, r.id);
  });
  s.audit({ op: "retro-taint", detail: `${marks.length} note(s) marked ${tag}` });
  return marks.length;
}

// ---- r2-innovation #1: the echo guard ------------------------------------------------------------------------------
// A note that restates a note THIS session was shown is not new evidence. "Shown" = what Monomem recorded giving the writer:
// the session-start receipts of an open session launched in the writer's folder (local writers only, matched like the hook
// window), plus the unconfirmed notes this connection read (ActorRef.taintedReads). The echo is linked to the original
// (derived_from), so it inherits that note's unconfirmed / distrusted status and its writer cannot confirm the original;
// it carries obs.echo_of:<id> so every reader sees the label. Label only: an echo is never refused.

export const ECHO_TAG_PREFIX = "obs.echo_of:";
/** Similarity (TF cosine over title + body) at or above which a write restates a shown note. */
export const ECHO_MIN_SIMILARITY = 0.8;
/** Fewer content tokens than this and a write is too short to call an echo (short generic notes match everything). */
export const ECHO_MIN_TOKENS = 6;
/** Most shown notes compared per write. */
const ECHO_MAX_CANDIDATES = 60;

/** The id of the shown note this text restates, or null. Reads only. */
export function echoOf(s: Store, title: string, body: string): number | null {
  const words = tokenize(`${title}\n${body}`);
  if (words.length < ECHO_MIN_TOKENS) return null;
  const ids = shownToThisSession(s);
  if (!ids.length) return null;
  const mine = termFreq(words);
  let best: { id: number; sim: number } | null = null;
  for (const id of ids) {
    const n = s.readVisible(id, { hideArchived: true });
    if (!n) continue;
    const sim = cosineOfFreq(mine, termFreq(tokenize(`${n.title}\n${n.body}`)));
    if (sim >= ECHO_MIN_SIMILARITY && (!best || sim > best.sim)) best = { id, sim };
  }
  return best?.id ?? null;
}

function shownToThisSession(s: Store): number[] {
  const actor = actorStore.getStore();
  const out = new Set<number>();
  const h = taintWindowHours();
  const cutoff = Date.now() - (h > 0 ? h : 12) * 3_600_000;
  for (const [id, at] of actor?.taintedReads ?? []) if (at >= cutoff) out.add(id);
  if (actor?.authed !== true && actor?.cwd) {
    const sessions = s.activeSessions().filter((x) => sameFolder(x.cwd, actor.cwd as string)).map((x) => x.id);
    if (sessions.length && s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_receipts'").get()) {
      const rows = s.db
        .prepare(`SELECT note_id FROM memory_receipts WHERE session_id IN (${sessions.map(() => "?").join(",")}) ORDER BY rank LIMIT ?`)
        .all(...sessions, ECHO_MAX_CANDIDATES) as Array<{ note_id: number }>;
      for (const r of rows) out.add(Number(r.note_id));
    }
  }
  return [...out].slice(0, ECHO_MAX_CANDIDATES);
}
