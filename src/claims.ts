// Claim checks and hashed line citations (PLAN I, r2-innovation #3, r2-competition #3). A note can carry checks against
// the files of the git repository it was written in:
//   { file, contains: "text" }      the file holds this exact text (case-sensitive, literal; no regular expressions)
//   { file, dependency: "name" }    the JSON file (package.json) lists it in dependencies / dev / peer / optional
//   { file, exists: true }          the file is there
//   { file, lines: "10-20" }        a citation: the hash of those lines is stored; later reads compare it
//   "src/a.ts:10-20"                the same citation, written as text
// Every check must hold when the note is written (a false claim is refused). On read, a check that no longer holds labels
// the note `[no longer true in code: ...]` / `[cited code changed: ...]`; the note is never hidden, changed or deleted for it.
// Files only: nothing is ever run. Paths stay inside the repository root (the same rules as code anchors, code-anchor.ts),
// a symlink leading out of it is never read, and a file over MAX_BYTES is not read. Storage: the code_claims side table
// (CREATE TABLE IF NOT EXISTS on the first claim; no schema version bump). Paths and check text, never note text.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NoteRecord, NoteRow, Store } from "./store.js";
import { actorStore, currentWriter } from "./actor.js";
import { ValidationError } from "./errors.js";
import { printable } from "./security.js";
import { inside, MAX_FILES, repoPaths } from "./code-anchor.js";

export const MAX_BYTES = 1 << 20;
const MAX_TEXT = 200;
const MAX_SPAN = 200;

export type ClaimInput = string | { file: string; contains?: string; dependency?: string; exists?: boolean; lines?: string };
type Kind = "contains" | "dependency" | "exists" | "lines";
/** One claim as stored. `arg`: the text, package name, or "start-end"; `hash`: sha256 of the cited lines ("" otherwise). */
export interface Claim { kind: Kind; path: string; arg: string; hash: string; root: string }
/** One claim that no longer holds, as a reader sees it. */
export interface ClaimFailure { path: string; check: string; why: string }
/** One row of `monomem review code` (claims pass). */
export interface ClaimFailedItem { id: number; namespace: string; title: string; writer: string; pinned: boolean; failed: ClaimFailure[] }

const SCHEMA = `CREATE TABLE IF NOT EXISTS code_claims (
  note_id INTEGER NOT NULL,
  n INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  arg TEXT NOT NULL,
  hash TEXT NOT NULL DEFAULT '',
  repo_root TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (note_id, n)
);
CREATE TRIGGER IF NOT EXISTS notes_code_claims_ad AFTER DELETE ON notes BEGIN
  DELETE FROM code_claims WHERE note_id = old.id;
END;`;

const LINES = /^(\d{1,7})(?:-(\d{1,7}))?$/;

/** `claims` from a request, checked for shape only (no file is read). Throws ValidationError. */
export function checkClaimsInput(claims: unknown): Array<{ file: string; kind: Kind; arg: string }> | undefined {
  if (claims === undefined) return undefined;
  if (!Array.isArray(claims)) throw new ValidationError("claims must be a list");
  if (claims.length > MAX_FILES) throw new ValidationError(`claims: at most ${MAX_FILES}`);
  return claims.map((c, i) => {
    const at = `claims[${i}]`;
    if (typeof c === "string") {
      const m = /^(.+):(\d{1,7}(?:-\d{1,7})?)$/.exec(c.trim());
      if (!m) throw new ValidationError(`${at}: a text claim is a line citation, "path:start-end"`);
      return lineClaim(m[1], m[2], at);
    }
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new ValidationError(`${at}: a claim is "path:start-end" or { file, contains | dependency | exists | lines }`);
    const o = c as Record<string, unknown>;
    const keys = (["contains", "dependency", "exists", "lines"] as const).filter((k) => o[k] !== undefined);
    const unknown = Object.keys(o).filter((k) => k !== "file" && !(keys as readonly string[]).includes(k));
    if (keys.length !== 1 || unknown.length) throw new ValidationError(`${at}: give "file" and exactly one of contains, dependency, exists, lines`);
    const file = checkPath(o.file, at);
    const kind = keys[0];
    if (kind === "lines") return lineClaim(file, o.lines, at);
    if (kind === "exists") {
      if (o.exists !== true) throw new ValidationError(`${at}: exists must be true`);
      return { file, kind, arg: "" };
    }
    const v = o[kind];
    if (typeof v !== "string" || !v || v.length > MAX_TEXT || /[\u0000-\u0008\u000b-\u001f]/.test(v)) {
      throw new ValidationError(`${at}: ${kind} is 1-${MAX_TEXT} printable characters`);
    }
    return { file, kind, arg: v };
  });
}

function checkPath(f: unknown, at: string): string {
  if (typeof f !== "string" || !f.trim()) throw new ValidationError(`${at}: file must be a non-empty path`);
  if (f.length > 500 || /[\u0000-\u001f]/.test(f)) throw new ValidationError(`${at}: a path is at most 500 printable characters`);
  if (f.split(/[\\/]/).includes("..")) throw new ValidationError(`${at}: a path may not contain '..'`);
  return f.trim();
}

function lineClaim(file: unknown, span: unknown, at: string): { file: string; kind: Kind; arg: string } {
  const m = typeof span === "string" ? LINES.exec(span.trim()) : null;
  const start = Number(m?.[1]);
  const end = Number(m?.[2] ?? m?.[1]);
  if (!m || start < 1 || end < start || end - start >= MAX_SPAN) throw new ValidationError(`${at}: lines is "start-end" (1-based, at most ${MAX_SPAN} lines)`);
  return { file: checkPath(file, at), kind: "lines", arg: `${start}-${end}` };
}

/**
 * File text by real path, re-read only when size or mtime moves, with the line hashes already worked out for it (a read
 * re-checks every claim; a big cited file was split and hashed again each time). ponytail: 64 entries, cleared when full.
 */
const textCache = new Map<string, { size: number; mtimeMs: number; text: string; hashes: Map<string, string | null> }>();

/** The text of `rel` under `root`, or why it cannot be read. Never reads through a symlink that leaves the root. */
function readInRepo(root: string, rel: string): { text: string; hashes: Map<string, string | null> } | { why: string } {
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
    real = realpathSync.native(join(root, ...rel.split("/")));
  } catch {
    return { why: "file gone" };
  }
  if (!inside(realRoot, real)) return { why: "path leads outside the repository" };
  let st;
  try {
    st = statSync(real);
  } catch {
    return { why: "file gone" };
  }
  if (!st.isFile()) return { why: "not a file" };
  if (st.size > MAX_BYTES) return { why: `file over ${MAX_BYTES >> 20} MB, not read` };
  const hit = textCache.get(real);
  // ponytail: a same-size rewrite inside one mtime tick (coarse 1-2 s clocks: FAT, old HFS+) reads as unchanged until the next write.
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
  let text: string;
  try {
    text = readFileSync(real, "utf8");
  } catch {
    return { why: "file not readable" };
  }
  if (textCache.size >= 64) textCache.clear();
  const entry = { size: st.size, mtimeMs: st.mtimeMs, text, hashes: new Map<string, string | null>() };
  textCache.set(real, entry);
  return entry;
}

const lineHash = (text: string, arg: string): string | null => {
  const [start, end] = arg.split("-").map(Number);
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"); // a final newline ends the last line, it adds none
  if (end > lines.length) return null;
  return createHash("sha256").update(lines.slice(start - 1, end).join("\n")).digest("hex");
};

function hasDependency(text: string, name: string): boolean {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some((k) => {
      const d = j[k];
      return !!d && typeof d === "object" && Object.hasOwn(d, name);
    });
  } catch {
    return false;
  }
}

/** Why `c` does not hold now ("" = it holds). */
function evaluate(c: Claim): string {
  const r = readInRepo(c.root, c.path);
  if ("why" in r) return r.why;
  switch (c.kind) {
    case "exists":
      return "";
    case "contains":
      return r.text.includes(c.arg) ? "" : "text not found";
    case "dependency":
      return hasDependency(r.text, c.arg) ? "" : "dependency not listed";
    case "lines": {
      let h = r.hashes.get(c.arg);
      if (h === undefined) r.hashes.set(c.arg, (h = lineHash(r.text, c.arg)));
      return h === null ? "lines gone" : h === c.hash ? "" : "cited code changed";
    }
  }
}

/** "5-5" reads as "5". */
const span = (arg: string): string => { const [a, b] = arg.split("-"); return a === b ? a : arg; };
const describe = (c: Pick<Claim, "kind" | "path" | "arg">): string =>
  c.kind === "lines" ? `${c.path}:${span(c.arg)}` : c.kind === "exists" ? `${c.path} exists` : `${c.path} ${c.kind === "contains" ? "contains" : "has dependency"} ${JSON.stringify(c.arg)}`;

/**
 * The claims for a new note, checked now from the writer's folder (a local server's launch folder, else this process's).
 * Runs before the write lock. Throws ValidationError for a bad path, no git repository, or a claim that is not true now.
 */
export function prepareClaims(input: unknown): Claim[] {
  const list = checkClaimsInput(input);
  if (!list?.length) return [];
  const where = repoPaths(list.map((c) => c.file), actorStore.getStore()?.cwd ?? process.cwd(), "claims");
  if (!where) throw new ValidationError("claims: they are checked against a git repository with a commit; write the note from inside one");
  return list.map((c, i) => {
    const claim: Claim = { kind: c.kind, path: where.rels[i], arg: c.arg, hash: "", root: where.root };
    if (c.kind === "lines") {
      const r = readInRepo(where.root, claim.path);
      const h = "text" in r ? lineHash(r.text, c.arg) : null;
      if (h === null) throw new ValidationError(`claims[${i}]: ${printable(describe(claim), 200)}: ${"why" in r ? r.why : "lines gone"}`);
      return { ...claim, hash: h };
    }
    const why = evaluate(claim);
    if (why) throw new ValidationError(`claims[${i}]: ${printable(describe(claim), 200)} is not true now (${why})`);
    return claim;
  });
}

/** code_claims exists and has rows; an empty answer is re-asked at most once a second (same as code anchors). */
const seen = new WeakMap<Store, { any: boolean; at: number }>();
function anyClaims(s: Store): boolean {
  const c = seen.get(s);
  if (c && (c.any || Date.now() - c.at < 1000)) return c.any;
  const any = !!s.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'code_claims'").get() && !!s.db.prepare("SELECT 1 FROM code_claims LIMIT 1").get();
  seen.set(s, { any, at: Date.now() });
  return any;
}

/** Store a new note's claims. Runs inside the caller's write transaction. */
export function setClaims(s: Store, noteId: number, claims: readonly Claim[], at: string): void {
  if (!claims.length) return;
  s.db.exec(SCHEMA);
  s.db.prepare("DELETE FROM code_claims WHERE note_id = ?").run(noteId);
  const ins = s.db.prepare("INSERT INTO code_claims (note_id, n, kind, path, arg, hash, repo_root, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  claims.forEach((c, i) => ins.run(noteId, i + 1, c.kind, c.path, c.arg, c.hash, c.root, at));
  seen.set(s, { any: true, at: Date.now() });
}

function claimsOf(s: Store, noteId: number): Array<Claim & { n: number }> {
  return (s.db.prepare("SELECT n, kind, path, arg, hash, repo_root FROM code_claims WHERE note_id = ? ORDER BY n").all(noteId) as Array<{ n: number; kind: Kind; path: string; arg: string; hash: string; repo_root: string }>).map(
    (r) => ({ n: Number(r.n), kind: r.kind, path: r.path, arg: r.arg, hash: r.hash, root: r.repo_root })
  );
}

const labelPath = (p: string): string => printable(p, 80).replace(/\[/g, "(").replace(/\]/g, ")");
const list3 = (xs: string[]): string => `${xs.slice(0, 3).join(", ")}${xs.length > 3 ? `, +${xs.length - 3}` : ""}`;

/** rec(): `claims_failed` and `claims_label` when a claim no longer holds; other notes keep their shape. */
export function annotateClaims(s: Store, row: NoteRow, out: NoteRecord): NoteRecord {
  if (row.archived_at || !anyClaims(s)) return out;
  const failed: ClaimFailure[] = [];
  const cited: string[] = [];
  const untrue: string[] = [];
  for (const c of claimsOf(s, Number(row.id))) {
    const why = evaluate(c);
    if (!why) continue;
    failed.push({ path: printable(c.path, 200), check: printable(describe(c), 300), why });
    // The label names paths and line numbers only, never the claim's text (agent text stays out of labels).
    if (c.kind === "lines") cited.push(`${labelPath(c.path)}:${span(c.arg)}`);
    else untrue.push(`claim ${c.n} on ${labelPath(c.path)}`);
  }
  if (!failed.length) return out;
  out.claims_failed = failed;
  out.claims_label = [untrue.length ? `[no longer true in code: ${list3(untrue)}]` : "", cited.length ? `[cited code changed: ${list3(cited)}]` : ""].filter(Boolean).join(" ");
  return out;
}

/** Live notes this caller may see with a claim that no longer holds, and how many notes with claims still all hold. */
export function claimsReview(s: Store, namespaces?: string[]): { failed: ClaimFailedItem[]; holding: number } {
  if (!anyClaims(s)) return { failed: [], holding: 0 };
  const ids = (s.db
    .prepare(
      `SELECT DISTINCT n.id FROM notes n JOIN code_claims c ON c.note_id = n.id
        WHERE n.archived_at IS NULL${namespaces ? ` AND n.namespace IN (${namespaces.map(() => "?").join(",")})` : ""} ORDER BY n.id DESC LIMIT 500`
    )
    .all(...(namespaces ?? [])) as Array<{ id: number }>).map((r) => Number(r.id));
  const failed: ClaimFailedItem[] = [];
  let holding = 0;
  for (const id of ids) {
    const n = s.readVisible(id, { hideArchived: true });
    if (!n) continue;
    if (n.claims_failed) failed.push({ id: n.id, namespace: n.namespace, title: n.title, writer: n.written_by, pinned: n.pinned === true, failed: n.claims_failed });
    else holding++;
  }
  return { failed, holding };
}

/**
 * A person says the note still holds: a changed citation is re-hashed to the lines as they are now; a citation whose lines
 * are gone and a check that no longer holds are dropped (the person judged the note, not the check). Returns how many moved.
 */
export function keepClaims(s: Store, id: number): number {
  if (!anyClaims(s)) return 0;
  const fixes = claimsOf(s, id).flatMap((c) => {
    if (!evaluate(c)) return [];
    const r = c.kind === "lines" ? readInRepo(c.root, c.path) : null;
    const h = r && "text" in r ? lineHash(r.text, c.arg) : null;
    return [{ n: c.n, hash: h }];
  });
  if (!fixes.length) return 0;
  return s.transaction(() => {
    const upd = s.db.prepare("UPDATE code_claims SET hash = ?, at = ? WHERE note_id = ? AND n = ?");
    const del = s.db.prepare("DELETE FROM code_claims WHERE note_id = ? AND n = ?");
    const at = new Date().toISOString();
    for (const f of fixes) {
      if (f.hash !== null) upd.run(f.hash, at, id, f.n);
      else del.run(id, f.n);
    }
    s.audit({ op: "code-claims-keep", id, detail: currentWriter() || "cli" });
    return fixes.length;
  });
}

/** `monomem review code` (claims pass): the operator reads this at a terminal. */
export function printClaimsReview(r: { failed: ClaimFailedItem[]; holding: number }): void {
  if (r.failed.length) {
    console.log(`${r.failed.length} note${r.failed.length === 1 ? " has a claim" : "s have claims"} no longer true in code:`);
    for (const c of r.failed) {
      console.log(`  #${c.id} [${printable(c.namespace, 100)}] ${printable(c.title, 120)} (by ${printable(c.writer || "unknown", 100)})${c.pinned ? " pinned" : ""}`);
      for (const f of c.failed.slice(0, 5)) console.log(`      ${f.check}: ${f.why}`);
    }
    console.log('  Still right: monomem review keep <id>. Out of date: monomem replace --old <id> --title "..." --body "..." (shows what changes, then asks).\n');
  }
  if (r.holding) console.log(`${r.holding} note${r.holding === 1 ? "'s claims and cited code still match" : "s' claims and cited code still match"} the files.`);
}
