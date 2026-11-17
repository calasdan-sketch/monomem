// Instruction-file watch (PLAN D, "AGENTS.md / CLAUDE.md block watch"): at session start, say in ONE line when the session
// folder's AGENTS.md or CLAUDE.md changed since the last session Monomem saw there, and whether the Monomem block
// (`monomem project-rules`, between its fence lines) changed too. A planted line in a rules file is the attack that works on
// coding agents today, and an agent reads these files as instructions. Notice only: the file is never edited, and its text is
// never printed (a file name and "changed" are the whole message).
//
// Hashes live in a side table of the capture database (CREATE TABLE IF NOT EXISTS, like receipts.ts: no schema bump).
// The first sight of a file records it and says nothing. `monomem project-rules` records what it wrote (recordRulesFile), so
// its own block update is not reported as a change.
// ponytail: only the session folder itself is looked at (not the git root or parent folders Claude Code also reads).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { FENCE_BEGIN, FENCE_END, RULES_FILES } from "./project-rules.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS rules_file_watch (
  path TEXT PRIMARY KEY,
  file_sha TEXT NOT NULL,
  block_sha TEXT NOT NULL,
  seen_at TEXT NOT NULL
)`;
/** A rules file bigger than this is hashed on its first 1 MiB only. */
const MAX_BYTES = 1024 * 1024;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const key = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

/**
 * The file's hashes now (null: no file). block_sha is "" when the file has no Monomem block. file_sha is
 * "<whole file>|o:<text outside the block>" (r4 L2): the outside part is hashed on its own, whitespace-folded, so a
 * project-rules write (which changes only the block, and may add a blank line) can tell a planted line outside it.
 * A row from before carries the whole-file hash alone; it compares the same way.
 */
function hashes(file: string): { file_sha: string; block_sha: string; outside: string } | null {
  let text: string;
  try {
    text = readFileSync(file).subarray(0, MAX_BYTES).toString("utf8");
  } catch {
    return null;
  }
  const b = text.indexOf(FENCE_BEGIN);
  const e = b >= 0 ? text.indexOf(FENCE_END, b) : -1;
  const out = e > b ? text.slice(0, b) + "\n" + text.slice(e + FENCE_END.length) : text;
  const outside = sha(out.replace(/\s+/g, " ").trim());
  return { file_sha: `${sha(text)}|o:${outside}`, block_sha: e > b ? sha(text.slice(b, e)) : "", outside };
}

const wholeOf = (fileSha: string): string => fileSha.split("|")[0];
const outsideOf = (fileSha: string): string | undefined => /\|o:([0-9a-f]+)$/.exec(fileSha)?.[1];

/**
 * Record a rules file as it is now. `ownWrite` (project-rules, after writing its block): when the text OUTSIDE the block
 * changed since the last session too, that change is not Monomem's, so the old whole-file hash is kept and the next session
 * start still reports "changed" once. Best effort.
 */
export function recordRulesFile(db: DatabaseSync, file: string, now: Date = new Date(), ownWrite = false): void {
  const h = hashes(file);
  db.exec(SCHEMA);
  if (!h) {
    db.prepare("DELETE FROM rules_file_watch WHERE path = ?").run(key(file));
    return;
  }
  const was = ownWrite ? (db.prepare("SELECT file_sha FROM rules_file_watch WHERE path = ?").get(key(file)) as { file_sha: string } | undefined) : undefined;
  const wasOutside = was ? outsideOf(was.file_sha) : undefined;
  const planted = wasOutside !== undefined && wasOutside !== h.outside;
  const fileSha = planted ? `${wholeOf(was!.file_sha)}|o:${wasOutside}` : h.file_sha;
  db.prepare("INSERT OR REPLACE INTO rules_file_watch (path, file_sha, block_sha, seen_at) VALUES (?, ?, ?, ?)").run(key(file), fileSha, h.block_sha, now.toISOString());
}

/**
 * The one session-start line ("" when nothing changed), and the new hashes recorded. Names only the fixed file names.
 */
export function rulesWatchLine(db: DatabaseSync, cwd: string, now: Date = new Date()): string {
  db.exec(SCHEMA);
  const get = db.prepare("SELECT file_sha, block_sha FROM rules_file_watch WHERE path = ?");
  const parts: string[] = [];
  for (const name of RULES_FILES) {
    const file = join(cwd, name);
    const was = get.get(key(file)) as { file_sha: string; block_sha: string } | undefined;
    const is = hashes(file);
    if (was && !is) parts.push(`${name} was removed`);
    else if (was && is && wholeOf(was.file_sha) !== wholeOf(is.file_sha)) parts.push(was.block_sha !== is.block_sha ? `${name} changed, including its Monomem block (Monomem did not write that change)` : `${name} changed`);
    if (is || was) recordRulesFile(db, file, now);
  }
  if (!parts.length) return "";
  return `Monomem: since the last session here, ${parts.join("; ")}. Agents follow these files as instructions: read the change before you rely on it (git diff -- ${RULES_FILES.join(" ")}). Monomem only noticed it; nothing was edited.`;
}
