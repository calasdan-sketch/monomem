// Code-anchored staleness (R2-03, 1.5.0): the git side. A note can name the files it is about (`files`); at write time each
// one is pinned to its blob in git's index, and on read it is compared with the blob at HEAD. Local `git` only: execFile
// (no shell), a short timeout, a repo's own fsmonitor and hooks switched off, never a network command. HEAD is resolved by
// reading .git files, so a read costs no git call; the one `git ls-tree` per HEAD commit is cached (per repository root).
// No git, no commits, or a folder outside a repository: no anchors and no labels, exactly as before.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ValidationError } from "./errors.js";

export const MAX_FILES = 20;
const MAX_PATH = 500;
const GIT_TIMEOUT_MS = 2000;

/** One anchor as stored: path relative to the repository root (forward slashes), its blob, the commit at write time. */
export interface CodeAnchor { path: string; blob: string; commit: string; root: string }

/** Test spy: how many `git ls-tree` calls were made (one per repository HEAD), and `git rev-parse HEAD` fallbacks. */
export const gitStats = { lsTree: 0, revParse: 0 };

function git(cwd: string, args: string[], maxBuffer = 1 << 20): string | null {
  try {
    // A repo's own config must not make these read-only calls run a program: no fsmonitor hook, no hooks path.
    return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** `files` from a request: a list of at most 20 short strings, none with a `..` segment. Throws ValidationError. */
export function checkFilesInput(files: unknown): string[] | undefined {
  if (files === undefined) return undefined;
  if (!Array.isArray(files)) throw new ValidationError("files must be a list of file paths");
  if (files.length > MAX_FILES) throw new ValidationError(`files: at most ${MAX_FILES} paths`);
  return files.map((f) => {
    if (typeof f !== "string" || !f.trim()) throw new ValidationError("files: each entry must be a non-empty path");
    if (f.length > MAX_PATH || /[\u0000-\u001f]/.test(f)) throw new ValidationError(`files: a path is at most ${MAX_PATH} printable characters`);
    if (f.split(/[\\/]/).includes("..")) throw new ValidationError("files: a path may not contain '..'");
    return f.trim();
  });
}

export const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Where `files` (named from `cwd`) are in their git repository: the root as git names it, its real path, HEAD, and each path
 * relative to the root (forward slashes). null when `cwd` is not in a repository with a commit (or git is missing). Throws
 * ValidationError for a path outside the repository, through a symlink out of it, or naming a folder. `what` names the
 * request field in messages. Shared by code anchors and claim checks (../claims.ts). */
export function repoPaths(files: string[], cwd: string, what = "files"): { root: string; realRoot: string; commit: string; rels: string[] } | null {
  const top = git(cwd, ["rev-parse", "--show-toplevel", "HEAD"]);
  const [rootRaw, commit] = (top ?? "").split("\n").map((s) => s.trim());
  if (!rootRaw || !/^[0-9a-f]{40,64}$/.test(commit ?? "")) return null;
  const root = resolve(rootRaw);
  let realRoot: string;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    return null;
  }
  // git reports the real path; a cwd reached through a link or an 8.3 short name (macOS /var -> /private/var, Windows
  // RUNNER~1) names the same folder differently, so a relative path is also tried from the real cwd.
  let realCwd = cwd;
  try {
    realCwd = realpathSync.native(cwd);
  } catch {
    /* unreadable cwd: keep it as given */
  }
  const rels = files.map((f) => {
    const given = resolve(cwd, f);
    const abs = inside(root, given) || inside(realRoot, given) ? given : resolve(realCwd, f);
    if (!inside(root, abs) && !inside(realRoot, abs)) throw new ValidationError(`${what}: a path must be inside this repository`);
    if (existsSync(abs)) {
      let real: string;
      try {
        real = realpathSync.native(abs);
      } catch {
        throw new ValidationError(`${what}: a path could not be checked`);
      }
      if (!inside(realRoot, real)) throw new ValidationError(`${what}: a path leads outside this repository (symlink)`);
      if (statSync(real).isDirectory()) throw new ValidationError(`${what}: name files, not folders`);
    }
    const rel = relative(inside(root, abs) ? root : realRoot, abs).split(sep).join("/");
    if (!rel || rel.startsWith("../") || isAbsolute(rel)) throw new ValidationError(`${what}: a path must be inside this repository`);
    return rel;
  });
  return { root, realRoot, commit: commit!, rels };
}

/**
 * Anchors for `files` written from `cwd`: each path must be inside the repository that holds `cwd` (no absolute path
 * outside it, no symlink out of it) and tracked by git. [] when `cwd` is not in a repository with a commit (or git is
 * missing): the note is written without anchors, as before. Throws ValidationError for a path that breaks the rules.
 */
export function anchorsFor(files: string[], cwd: string): CodeAnchor[] {
  if (!files.length) return [];
  const where = repoPaths(files, cwd);
  if (!where) return [];
  const { root, commit } = where;
  const rels = [...new Set(where.rels)];
  // The blob in the index: what the file will be once committed. No filters run (ls-files never calls a clean filter).
  const out = git(root, ["ls-files", "-s", "-z", "--", ...rels.map((r) => `:(literal)${r}`)]) ?? "";
  const blobs = new Map<string, string>();
  for (const rec of out.split("\0")) {
    const m = /^\d+ ([0-9a-f]{40,64}) \d+\t(.+)$/s.exec(rec);
    if (m) blobs.set(m[2], m[1]);
  }
  return rels.map((rel) => {
    const blob = blobs.get(rel);
    if (!blob) throw new ValidationError(`files: ${rel.slice(0, 120)} is not tracked by git here (git add it first)`);
    return { path: rel, blob, commit, root };
  });
}

/** The commit HEAD points at, read from the .git files (no git call); null when it cannot be read that way. */
export function headCommit(root: string): string | null {
  try {
    let gitDir = join(root, ".git");
    if (statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, "utf8"));
      if (!m) return null;
      gitDir = resolve(root, m[1].trim());
    }
    const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
    const ref = /^ref:\s*(refs\/\S+)$/.exec(head)?.[1];
    if (!ref || ref.split("/").includes("..")) return null;
    for (const dir of [gitDir, common]) {
      const p = join(dir, ...ref.split("/"));
      if (existsSync(p)) {
        const sha = readFileSync(p, "utf8").trim();
        return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
      }
    }
    const packed = join(common, "packed-refs");
    if (!existsSync(packed)) return null;
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
  } catch {
    /* not readable as plain files (reftable, permissions): fall through */
  }
  return null;
}

/** Per repository root: the blobs of the last HEAD seen. ponytail: whole-tree listing, once per HEAD; fine to ~100k files. */
const treeCache = new Map<string, { head: string; blobs: Map<string, string> }>();
/** Per repository root: when git last could not say (SF-1). Roots are the few repositories notes were written in. */
const treeMisses = new Map<string, number>();
const MISS_TTL_MS = 60_000;

function revParseHead(root: string): string {
  gitStats.revParse++;
  return git(root, ["rev-parse", "HEAD"])?.trim() ?? "";
}

/** The blobs at HEAD for `root` (path -> sha) and the HEAD commit; null when git cannot say. One git call per HEAD. */
export function headBlobs(root: string): { head: string; blobs: Map<string, string> } | null {
  // SF-1: a folder git could not answer for (.git gone or unreadable, reftable, no git) is not asked again for a minute,
  // so reading notes anchored there does not spawn git on every read.
  const missed = treeMisses.get(root);
  if (missed !== undefined && Date.now() - missed < MISS_TTL_MS) return null;
  const head = headCommit(root) ?? revParseHead(root);
  if (!/^[0-9a-f]{40,64}$/.test(head)) {
    treeMisses.set(root, Date.now());
    return null;
  }
  const hit = treeCache.get(root);
  if (hit?.head === head) return hit;
  gitStats.lsTree++;
  const out = git(root, ["ls-tree", "-r", "-z", "--full-tree", head], 256 << 20);
  if (out === null) {
    treeMisses.set(root, Date.now());
    return null;
  }
  const blobs = new Map<string, string>();
  for (const rec of out.split("\0")) {
    const m = /^\d+ blob ([0-9a-f]{40,64})\t(.+)$/s.exec(rec);
    if (m) blobs.set(m[2], m[1]);
  }
  const entry = { head, blobs };
  treeCache.set(root, entry);
  return entry;
}

/** The anchors whose file at HEAD is no longer the blob they were written against (deleted counts as changed). */
export function changedAnchors(anchors: readonly CodeAnchor[]): CodeAnchor[] {
  const out: CodeAnchor[] = [];
  for (const a of anchors) {
    const t = headBlobs(a.root);
    if (!t || t.head === a.commit) continue; // nothing committed since the note was written
    if ((t.blobs.get(a.path) ?? "") !== a.blob) out.push(a);
  }
  return out;
}
