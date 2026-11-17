// PLAN I: the memory-to-commit trail and branch-scoped memory.
//
// Branch scope: a note written by a local agent server (notes.writer_cwd) also records the git repository and branch it was
// written on, in the side table note_branches (CREATE TABLE IF NOT EXISTS, no schema bump; not synced to other computers).
// The branch is read from the .git files (no git process per write). Session start (context-inject.ts) ranks this repo's
// notes first, the current branch's first of all; a live other branch's notes are labelled "(branch x)" and kept back
// unless they match the work. A branch that is merged into HEAD or deleted no longer scopes: its notes count as the repo's.
//
// Commit trail: the notes a session used (its receipts: shown at session start or by the prompt step) and wrote, linked to
// the commits made in that session's repository between its start and end (git log; commits by this machine's git
// identity only). An opt-in prepare-commit-msg hook adds "Monomem-Notes: #12 #40" to commit messages; a commit that
// carries the line is taken at its word. Note ids only, never titles or text (the receipts.ts rule).
//
// Every git call: execFile (no shell), fixed arguments built from validated values, a timeout, no network commands, and
// the repo's fsmonitor and hooks turned off so a cloned repo's config cannot make a read run a program.
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const TRAILER_KEY = "Monomem-Notes";
const GIT_TIMEOUT_MS = 400;
const LOG_TIMEOUT_MS = 3000;

/**
 * stdout of a read-only git command; "" when git answered with an error (not a repository, no such ref); null when git did
 * not answer: it timed out or is not installed (silent L2: say so, never "no commits").
 */
export function gitTry(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string | null> {
  return new Promise((done) => {
    try {
      execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...args], { cwd, timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, out) => done(!err ? String(out) : err.killed || (err as NodeJS.ErrnoException).code === "ENOENT" ? null : ""));
    } catch {
      done(null);
    }
  });
}

/** stdout of a read-only git command ("" on any failure or timeout). */
export const gitRun = async (cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> => (await gitTry(cwd, args, timeout)) ?? "";

/** What a person reads when git did not answer (a timeout, an error, git missing). */
export const GIT_NO_ANSWER = "git did not answer";

/** A folder in comparable form: real path (git reports /private/var for macOS /var), "/" separators, no trailing "/", lowercased on Windows. */
const realDirs = new Map<string, string>();
export function normDir(p: string): string {
  let real = realDirs.get(p);
  if (real === undefined) {
    try {
      real = realpathSync.native(p);
    } catch {
      real = resolve(p); // gone or unreadable: compare as written
    }
    if (realDirs.size > 1000) realDirs.clear(); // ponytail: crude cap; folders seen per process are few
    realDirs.set(p, real);
  }
  const r = real.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/**
 * C18: `dir` is `root` or inside it. One-way on purpose: a server launched in the home folder (some apps do) contains every
 * project, and must not count as "this project".
 */
export function insideFolder(dir: string | null | undefined, root: string | null | undefined): boolean {
  if (!dir || !root) return false;
  const a = normDir(dir);
  const b = normDir(root);
  return a === b || a.startsWith(b + "/");
}

// ---- branch scope ---------------------------------------------------------------------------------------------------

export interface HeadInfo {
  /** The repository's shared git folder (normDir form): the same for every worktree of one repository. */
  repo: string;
  /** The checked-out branch, or null when HEAD is detached. */
  branch: string | null;
}

/** Strip control and invisible characters; branch names come from the repo, so they are data. */
const cleanBranch = (b: string): string => b.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g, "").slice(0, 200);

/** The repository and branch of `dir`, read from the .git files (no git process); null outside a repository. */
export function gitHead(dir: string): HeadInfo | null {
  let d = resolve(dir);
  for (let i = 0; i < 64; i++) {
    const dot = join(d, ".git");
    let isFile: boolean | null = null;
    try {
      isFile = statSync(dot).isFile();
    } catch {
      /* not here: look one folder up */
    }
    if (isFile !== null) {
      try {
        let gitDir = dot;
        if (isFile) {
          const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dot, "utf8"));
          if (!m) return null;
          gitDir = resolve(d, m[1]);
        }
        let common = gitDir;
        try {
          common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
        } catch {
          /* a main checkout has no commondir file */
        }
        const m = /^ref:\s*refs\/heads\/(.+)$/.exec(readFileSync(join(gitDir, "HEAD"), "utf8").trim());
        return { repo: normDir(common), branch: m ? cleanBranch(m[1]) || null : null };
      } catch {
        return null;
      }
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

const BRANCH_TABLE = `CREATE TABLE IF NOT EXISTS note_branches (
  note_id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT,
  at TEXT NOT NULL
)`;
const ready = new WeakSet<DatabaseSync>();

/**
 * Record the repository and branch a local writer's folder is on (runs inside the caller's write transaction). A write from
 * no folder, or from outside a repository, clears the row: the note's latest content was not written on a branch.
 */
export function recordBranch(db: DatabaseSync, noteId: number, cwd: string | null): void {
  const head = cwd ? gitHead(cwd) : null;
  if (!head && !ready.has(db) && !hasBranchTable(db)) return; // nothing to record and nothing to clear
  if (!ready.has(db)) {
    db.exec(BRANCH_TABLE);
    ready.add(db);
  }
  if (head) db.prepare("INSERT OR REPLACE INTO note_branches (note_id, repo, branch, at) VALUES (?, ?, ?, ?)").run(noteId, head.repo, head.branch, new Date().toISOString());
  else db.prepare("DELETE FROM note_branches WHERE note_id = ?").run(noteId);
}

function hasBranchTable(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_branches'").get();
}

/** Writer folder, repository and branch of some notes (ids not found are left out). */
export function noteScopes(db: DatabaseSync, ids: number[]): Map<number, { cwd: string | null; repo: string | null; branch: string | null }> {
  const out = new Map<number, { cwd: string | null; repo: string | null; branch: string | null }>();
  const branches = hasBranchTable(db);
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const q = branches
      ? `SELECT n.id, n.writer_cwd, b.repo, b.branch FROM notes n LEFT JOIN note_branches b ON b.note_id = n.id WHERE n.id IN (${part.map(() => "?").join(",")})`
      : `SELECT id, writer_cwd, NULL AS repo, NULL AS branch FROM notes WHERE id IN (${part.map(() => "?").join(",")})`;
    for (const r of db.prepare(q).all(...part) as Array<{ id: number; writer_cwd: string | null; repo: string | null; branch: string | null }>) {
      out.set(Number(r.id), { cwd: r.writer_cwd, repo: r.repo, branch: r.branch });
    }
  }
  return out;
}

/** Whether any note of `repo` was written on a branch other than `current` (decides if the git call below is needed). */
export function hasOtherBranchNotes(db: DatabaseSync, repo: string, current: string | null): boolean {
  return hasBranchTable(db) && !!db.prepare("SELECT 1 FROM note_branches WHERE repo = ? AND branch IS NOT NULL AND branch <> ? LIMIT 1").get(repo, current ?? "");
}

/** Local branches not merged into HEAD (one git call). A merged or deleted branch is not in it. null when git did not answer. */
export async function unmergedBranches(root: string): Promise<Set<string> | null> {
  const out = await gitTry(root, ["for-each-ref", "--no-merged=HEAD", "--format=%(refname:short)", "refs/heads/"]);
  if (out === null) return null;
  return new Set(out.split("\n").map((s) => cleanBranch(s.trim())).filter(Boolean));
}

/** A branch name as a short label in agent-visible text (no brackets, so it cannot fake a [type] tag). */
export function branchLabel(b: string): string {
  return ` (branch ${cleanBranch(b).replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").slice(0, 40)})`;
}

// ---- commit trail ---------------------------------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  cwd: string;
  started_at: string;
  ended_at: string | null;
}

export interface Commit {
  hash: string;
  /** Commit time, ISO. */
  at: string;
  subject: string;
  /** Note ids named by the commit's Monomem-Notes line; null when it has none. */
  listed: number[] | null;
}

const hasTable = (db: DatabaseSync, name: string): boolean => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** The notes a session used: shown (its receipt, in rank order) and written (by the session, or from its folder while it ran). */
export function sessionNotes(db: DatabaseSync, s: SessionRow, now = new Date()): { shown: number[]; written: number[] } {
  const shown = hasTable(db, "memory_receipts")
    ? (db.prepare("SELECT note_id FROM memory_receipts WHERE session_id = ? ORDER BY rank").all(s.id) as Array<{ note_id: number }>).map((r) => Number(r.note_id))
    : [];
  const until = s.ended_at ?? now.toISOString();
  const written: number[] = [];
  const rows = db
    .prepare("SELECT id, session_id, writer_cwd FROM notes WHERE archived_at IS NULL AND (session_id = ? OR (writer_cwd IS NOT NULL AND updated_at >= ? AND updated_at <= ?)) ORDER BY id")
    .all(s.id, s.started_at, until) as Array<{ id: number; session_id: string | null; writer_cwd: string | null }>;
  // ponytail: two sessions open in one folder at once both count a write from that folder; the commit line settles commits.
  for (const r of rows) if (r.session_id === s.id || (s.cwd && insideFolder(r.writer_cwd, s.cwd))) written.push(Number(r.id));
  return { shown, written };
}

/** Sessions that used a note: shown it (receipts), or wrote it (its session id, or its folder while it ran). Newest first. */
export function sessionsUsing(db: DatabaseSync, noteId: number, limit = 30): Array<SessionRow & { how: Set<"shown" | "written"> }> {
  const how = new Map<string, Set<"shown" | "written">>();
  const add = (sid: string, h: "shown" | "written"): void => void (how.get(sid) ?? how.set(sid, new Set()).get(sid)!).add(h);
  if (hasTable(db, "memory_receipts")) for (const r of db.prepare("SELECT DISTINCT session_id FROM memory_receipts WHERE note_id = ?").all(noteId) as Array<{ session_id: string }>) add(r.session_id, "shown");
  const n = db.prepare("SELECT session_id, writer_cwd, created_at, updated_at FROM notes WHERE id = ?").get(noteId) as
    | { session_id: string | null; writer_cwd: string | null; created_at: string; updated_at: string }
    | undefined;
  if (n?.session_id) add(n.session_id, "written");
  const sessions = db.prepare("SELECT id, cwd, started_at, ended_at FROM sessions WHERE cwd <> '' ORDER BY started_at DESC").all() as unknown as SessionRow[];
  if (n?.writer_cwd) {
    const now = new Date().toISOString();
    for (const s of sessions) {
      const inWindow = [n.created_at, n.updated_at].some((t) => t >= s.started_at && t <= (s.ended_at ?? now));
      if (inWindow && insideFolder(n.writer_cwd, s.cwd)) add(s.id, "written");
    }
  }
  return sessions.filter((s) => how.has(s.id)).slice(0, limit).map((s) => ({ ...s, how: how.get(s.id)! }));
}

const iso = (t: string): string | null => (Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : null);

/** Commits by this machine's git identity in `cwd`'s repository, committed between `from` and `to` (local branches only). null: git did not answer. */
export async function commitsBetween(cwd: string, from: string, to: string): Promise<Commit[] | null> {
  const since = iso(from);
  const until = iso(to);
  if (!since || !until) return [];
  try {
    if (!statSync(cwd).isDirectory()) return [];
  } catch {
    return [];
  }
  // A pulled commit keeps its own committer, so filtering on ours keeps other people's work out of the window.
  const me = (await gitRun(cwd, ["config", "user.email"])).trim();
  const out = await gitTry(
    cwd,
    ["log", "--branches", "--no-merges", "-n", "200", `--since=${since}`, `--until=${until}`, `--format=%H%x1f%cI%x1f%ce%x1f%s%x1f%(trailers:key=${TRAILER_KEY},valueonly,separator=%x20)%x1e`],
    LOG_TIMEOUT_MS
  );
  if (out === null) return null;
  const commits: Commit[] = [];
  for (const rec of out.split("\x1e")) {
    const [hash, at, email, subject, trailer] = rec.replace(/^\s+/, "").split("\x1f");
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash)) continue;
    if (me && email && email.toLowerCase() !== me.toLowerCase()) continue;
    const t = (trailer ?? "").trim();
    commits.push({ hash, at: iso(at) ?? at, subject: subject ?? "", listed: t ? [...t.matchAll(/#(\d+)/g)].map((m) => Number(m[1])) : null });
  }
  return commits;
}

export interface TrailHit {
  commit: Commit;
  session: string;
  how: Array<"shown" | "written" | "commit line">;
}

/**
 * The commits that used a note: made during a session that was shown it or wrote it. A commit whose Monomem-Notes line
 * does not name the note is left out (the line says what that commit's session used); one that names it says so.
 */
export async function commitsUsing(db: DatabaseSync, noteId: number, now = new Date(), noAnswer: string[] = []): Promise<TrailHit[]> {
  const hits = new Map<string, TrailHit>();
  for (const s of sessionsUsing(db, noteId)) {
    const commits = await commitsBetween(s.cwd, s.started_at, s.ended_at ?? now.toISOString());
    if (commits === null) noAnswer.push(s.cwd); // the caller says "git did not answer" for these folders
    for (const c of commits ?? []) {
      if (c.listed && !c.listed.includes(noteId)) continue;
      const how = [...s.how, ...(c.listed ? (["commit line"] as const) : [])];
      const prev = hits.get(c.hash);
      if (prev) prev.how = [...new Set([...prev.how, ...how])];
      else hits.set(c.hash, { commit: c, session: s.id, how });
    }
  }
  return [...hits.values()].sort((a, b) => (a.commit.at < b.commit.at ? 1 : -1));
}

/** The Monomem-Notes value for a commit made now in `top`: notes of the open sessions working inside it. "" when none. */
export function trailerValue(db: DatabaseSync, sessions: Array<{ id: string; cwd: string }>, top: string, max = 12): string {
  const ids: number[] = [];
  for (const a of sessions) {
    if (!insideFolder(a.cwd, top)) continue;
    const row = db.prepare("SELECT id, cwd, started_at, ended_at FROM sessions WHERE id = ?").get(a.id) as unknown as SessionRow | undefined;
    if (!row) continue;
    const { shown, written } = sessionNotes(db, row);
    for (const id of [...written, ...shown]) if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return "";
  const live = new Set(
    (db.prepare(`SELECT id FROM notes WHERE archived_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: number }>).map((r) => Number(r.id))
  );
  const keep = ids.filter((id) => live.has(id));
  const shownIds = keep.slice(0, max).map((id) => `#${id}`);
  return shownIds.length ? shownIds.join(" ") + (keep.length > max ? ` +${keep.length - max}` : "") : "";
}
