// PLAN I: `monomem commit-trail` (also `monomem activity --commits`) and the opt-in git commit line.
//   commit-trail              recent sessions and the commits made in each (newest first)
//   commit-trail on [--yes]   add a prepare-commit-msg hook to THIS repository (asks first) that adds
//                             "Monomem-Notes: #12 #40" to commit messages made while an agent session works here
//   commit-trail off          take that hook out again (only ours: a hook someone else wrote is never touched)
//   commit-trail status       is the hook in this repository?
//   commit-trail hook <file> [source]   what the git hook runs (always exits 0, never blocks a commit)
// The hook is per repository, never global (core.hooksPath set = refuse and print the line to add instead).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { TRAILER_KEY, commitsBetween, gitRun, sessionNotes, trailerValue, type SessionRow } from "../git-trail.js";
import { quoteShellArg, selfCommand, type SelfFacts } from "../self.js";
import { printable } from "../security.js";
import { errorLine, terminalIO } from "./shared.js";
import type { SetupEnv, SetupIO, SetupOptions } from "../setup.js";

export const HOOK_MARK = "# monomem commit-trail";
const HOOK_NAME = "prepare-commit-msg";

/** git with the repo's own hooks path visible (the read helper turns it off); fixed arguments, no shell, short timeout. */
function gitPlain(cwd: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    try {
      execFile("git", ["-c", "core.fsmonitor=false", ...args], { cwd, timeout: 2000, windowsHide: true }, (err, out) => done(err ? "" : String(out)));
    } catch {
      done("");
    }
  });
}

export type HookPlace = { ok: true; top: string; file: string } | { ok: false; reason: string };

/** Where this repository's prepare-commit-msg hook lives, or why Monomem will not put one there. */
export async function hookPlace(cwd: string): Promise<HookPlace> {
  const top = (await gitRun(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!top) return { ok: false, reason: "this folder is not inside a git repository" };
  if ((await gitPlain(cwd, ["config", "--get", "core.hooksPath"])).trim()) {
    return { ok: false, reason: "this repository sets core.hooksPath (a hook manager); add the line below to its prepare-commit-msg hook yourself" };
  }
  const rel = (await gitPlain(cwd, ["rev-parse", "--git-path", `hooks/${HOOK_NAME}`])).trim();
  if (!rel) return { ok: false, reason: "git did not say where this repository keeps its hooks" };
  return { ok: true, top, file: isAbsolute(rel) ? rel : resolve(cwd, rel) };
}

/** The hook script: runs `monomem commit-trail hook`, silent, and never fails the commit (also when Monomem is gone). */
export function hookScript(f: SelfFacts): string {
  const c = selfCommand(["commit-trail", "hook"], f);
  // Git runs hooks with sh on every platform (Git for Windows brings its own), so quote for sh.
  const cmd = [c.command, ...c.args].map((a) => quoteShellArg(a, "linux")).join(" ");
  return [
    "#!/bin/sh",
    `${HOOK_MARK}: adds "${TRAILER_KEY}: #12 #40" (the memory notes the agent session used) to commit messages.`,
    "# Remove: monomem commit-trail off",
    `${cmd} "$1" "$2" </dev/null >/dev/null 2>&1`,
    "exit 0",
    "",
  ].join("\n");
}

export const isOurs = (file: string): boolean => {
  try {
    return readFileSync(file, "utf8").includes(HOOK_MARK);
  } catch {
    return false;
  }
};

/** Write the hook. Refuses to replace a hook that is not ours. Returns the file and its sha256 (for setup --undo). */
export function installHook(file: string, f: SelfFacts): { file: string; sha: string } {
  if (existsSync(file) && !isOurs(file)) throw new Error(`${file} already exists and is not Monomem's; nothing was changed`);
  const text = hookScript(f);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, 0o755);
  return { file, sha: createHash("sha256").update(text).digest("hex") };
}

export function removeHook(file: string): boolean {
  if (!existsSync(file) || !isOurs(file)) return false;
  unlinkSync(file);
  return true;
}

async function openStore(hook = false): Promise<import("../store.js").Store> {
  const { DB_PATH } = await import("../config.js");
  const { Store } = await import("../store.js");
  return new Store(DB_PATH, hook ? { noMigrate: true, busyTimeoutMs: 200, bodyIndex: "off" } : {});
}

/** The git hook: add the Monomem-Notes line for the open sessions working in this repository. Never throws. */
export async function runHook(msgFile: string | undefined, source: string | undefined, cwd = process.cwd()): Promise<void> {
  // A merge, squash or amend (-c/-C/--amend) message is git's own or already made: leave it alone.
  if (!msgFile || (source && ["merge", "squash", "commit"].includes(source))) return;
  const file = resolve(cwd, msgFile);
  if (!existsSync(file) || readFileSync(file, "utf8").includes(`${TRAILER_KEY}:`)) return;
  const top = (await gitRun(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!top) return;
  const store = await openStore(true);
  let value = "";
  try {
    value = trailerValue(store.captureDb(), store.activeSessions(), top);
  } finally {
    store.close();
  }
  if (!/^(#\d+ ?)+(\+\d+)?$/.test(value)) return; // note ids only: nothing else may reach the commit message
  await gitRun(cwd, ["interpret-trailers", "--in-place", "--trailer", `${TRAILER_KEY}: ${value}`, file]);
}

/** The list: recent sessions that ran in a folder, the notes they used and the commits made while they ran. */
async function listCmd(json: boolean): Promise<void> {
  const store = await openStore();
  try {
    const db = store.captureDb();
    const sessions = db.prepare("SELECT id, cwd, started_at, ended_at FROM sessions WHERE cwd <> '' ORDER BY started_at DESC LIMIT 10").all() as unknown as SessionRow[];
    const out = [];
    for (const s of sessions) {
      const notes = sessionNotes(db, s);
      const commits = await commitsBetween(s.cwd, s.started_at, s.ended_at ?? new Date().toISOString());
      out.push({ session_id: s.id, cwd: s.cwd, started_at: s.started_at, ended_at: s.ended_at, shown: notes.shown, written: notes.written, commits });
    }
    if (json) return console.log(JSON.stringify(out, null, 2));
    if (!out.length) return console.log("No sessions with a folder yet: they are recorded by the automatic memory hooks (monomem setup --capture).");
    for (const r of out) {
      console.log(`session ${printable(r.session_id, 40)}  ${r.started_at.slice(0, 16).replace("T", " ")} UTC  ${printable(r.cwd, 80)}`);
      console.log(`  notes shown ${r.shown.length}, written ${r.written.length}; ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"} while it ran`);
      for (const c of r.commits.slice(0, 5)) console.log(`  ${c.hash.slice(0, 10)}  ${printable(c.subject, 70)}${c.listed ? `  (${TRAILER_KEY}: ${c.listed.map((n) => "#" + n).join(" ")})` : ""}`);
    }
    console.log("Commits are those made in the session's repository between its start and end, by this machine's git identity.");
  } finally {
    store.close();
  }
}

/** `monomem commit-trail [on|off|status|hook] ...` */
export async function commitTrailCmd(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "hook") {
    try {
      await runHook(rest[0], rest[1]);
    } catch {
      /* a commit must never fail because of Monomem */
    }
    return;
  }
  if (!sub || sub.startsWith("-")) return listCmd(args.includes("--json"));
  const place = await hookPlace(process.cwd());
  if (sub === "status") {
    if (!place.ok) return console.log(`Commit line: off (${place.reason}).`);
    return console.log(isOurs(place.file) ? `Commit line: on in ${place.top} (${place.file}).` : `Commit line: off in ${place.top}. Turn on: monomem commit-trail on`);
  }
  if (sub === "off") {
    if (!place.ok) return console.log(`Nothing to remove: ${place.reason}.`);
    return console.log(removeHook(place.file) ? `Removed the commit line hook from ${place.top}.` : `No Monomem commit line hook in ${place.top}; nothing changed.`);
  }
  if (sub === "on") {
    if (!place.ok) {
      console.error(errorLine(place.reason, `the hook line: ${selfCommand(["commit-trail", "hook"]).command} ... commit-trail hook "$1" "$2"`));
      process.exit(1);
    }
    if (isOurs(place.file)) return console.log(`Already on in ${place.top}.`);
    const io = terminalIO();
    if (!rest.includes("--yes")) {
      if (!io.interactive) {
        console.error(errorLine("turning the commit line on needs a yes", "run it at a terminal, or add --yes"));
        process.exit(1);
      }
      const a = (await io.ask(`${commitLineQuestion(place.top)} Type y: `)).trim().toLowerCase();
      if (a !== "y" && a !== "yes") return console.log("Nothing changed.");
    }
    try {
      installHook(place.file, (await import("../self.js")).selfFacts());
    } catch (e) {
      console.error(errorLine((e as Error).message, "add the hook line to that file yourself, or remove it first"));
      process.exit(1);
    }
    return console.log(`On: commits made in ${place.top} while an agent session works there get a "${TRAILER_KEY}: #N" line. Off: monomem commit-trail off`);
  }
  console.error(errorLine(`unknown part "${printable(sub, 40)}"`, "monomem commit-trail [on | off | status] (no part: the list)"));
  process.exit(1);
}

const commitLineQuestion = (top: string): string =>
  `Add a "${TRAILER_KEY}: #12 #40" line to commit messages made in ${top} while an agent session works there? It names only note numbers (never titles or text) and goes into this repository's history, which others may see. Only this repository; monomem commit-trail off removes it.`;

/**
 * Setup's offer (asks, default no; only at a terminal, inside a git repository, when the hook is not there yet). A yes is
 * recorded in setup's history, so `monomem setup --undo` removes the hook like any file setup created.
 */
export async function offerCommitTrail(e: SetupEnv, io: SetupIO, opts: SetupOptions): Promise<void> {
  if (!io.interactive || opts.yes || opts.dryRun) return;
  const place = await hookPlace(e.cwd);
  if (!place.ok || existsSync(place.file)) return;
  const a = (await io.ask(`\n${commitLineQuestion(place.top)} Type y, or press Enter to skip: `)).trim().toLowerCase();
  if (a !== "y" && a !== "yes") return;
  try {
    const { sha } = installHook(place.file, { mode: e.mode ?? "npm", execPath: e.execPath, cliPath: e.cliPath, platform: e.platform });
    const { readHistory, saveHistory, stamp } = await import("../setup.js");
    const all = readHistory(e);
    all.push({ id: stamp(e.now()), at: e.now().toISOString(), version: e.version, changes: [{ client: "git-hook", file: place.file, real: place.file, backup: null, createdFile: true, afterSha: sha, inverse: [], label: "commit line hook" }] });
    saveHistory(e, all);
    io.out(`Added the commit line hook: ${place.file}. Off: monomem commit-trail off (or monomem setup --undo)`);
  } catch (err) {
    io.err(`Could not add the commit line hook (${(err as Error).message}). Everything else is done.`);
  }
}
