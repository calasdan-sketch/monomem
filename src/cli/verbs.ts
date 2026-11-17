// 1.6 command names. Five words replace about twenty commands (check, review <part>, activity, tidy <job>, keys,
// settings, replace); each turns into the command that does the work, so there is one implementation. Every old name
// still works. Typed at a terminal it also prints one line naming the new form on stderr; piped or redirected output
// is unchanged, so no script breaks.

/** Old command -> the 1.6 way to say it. */
export const OLD_COMMANDS: Readonly<Record<string, string>> = {
  doctor: "check --setup",
  health: "check",
  drill: "check --attacks",
  "safety-report": "check --report",
  meter: "check --usage",
  quality: "review duplicates",
  quarantine: "review held",
  conflicts: "review conflicts",
  stale: "review code",
  changes: "activity",
  digest: "activity --summary",
  watch: "activity --follow",
  access: "activity --reads",
  consolidate: "tidy merge",
  "rebuild-edges": "tidy edges",
  reindex: "tidy reindex",
  decay: "tidy decay",
  scrub: "tidy scrub",
  "purge-deleted": "tidy scrub",
  token: "keys",
  config: "settings",
  supersede: "replace",
  forget: "archive",
  relevant: "search",
  init: "connect <app> --print",
  taint: "settings outside-window",
};

const CHECK_FLAGS: Record<string, string> = { "--setup": "doctor", "--attacks": "drill", "--usage": "meter", "--report": "safety-report" };
const REVIEW_PARTS: Record<string, string[]> = {
  held: ["quarantine"],
  duplicates: ["quality"],
  conflicts: ["conflicts"],
  code: ["stale", "--code"],
  facts: ["facts"],
};
const ACTIVITY_FLAGS: Record<string, string> = { "--follow": "watch", "--reads": "access", "--summary": "digest", "--writes": "audit" };
export const TIDY_JOBS: Readonly<Record<string, string>> = {
  merge: "consolidate",
  edges: "rebuild-edges",
  reindex: "reindex",
  decay: "decay",
  scrub: "scrub",
};
const RENAMES: Record<string, string> = { keys: "token", settings: "config", replace: "supersede" };

export const NEW_COMMANDS = ["check", "activity", "tidy", ...Object.keys(RENAMES)];

export const TIDY_HELP = [
  "monomem tidy <job>   Maintenance you rarely need; each job explains itself before it changes anything.",
  "  merge [--dry-run] [--yes]   Merge near-duplicate notes (was: consolidate)",
  "  edges [--yes]               Rebuild the similar-notes links (was: rebuild-edges)",
  "  reindex                     Add meaning-search vectors to notes that have none (was: reindex)",
  "  decay [--dry-run]           Archive captured observations nobody used for a long time (was: decay)",
  "  scrub [--yes]               Remove the text of long-deleted notes from the database file (was: scrub)",
].join("\n");

/**
 * The command line with a 1.6 word turned into the command that does the work (argv without node and the script).
 * null: nothing to translate. `tidy` with no job (or an unknown one) returns ["tidy"]: the caller prints TIDY_HELP.
 */
export function translateVerb(args: readonly string[]): string[] | null {
  const [cmd, ...rest] = args;
  if (cmd === "check") {
    const flag = rest.find((a) => Object.hasOwn(CHECK_FLAGS, a));
    return flag ? [CHECK_FLAGS[flag], ...rest.filter((a) => a !== flag)] : ["health", ...rest];
  }
  if (cmd === "review" && rest[0] && Object.hasOwn(REVIEW_PARTS, rest[0])) return [...REVIEW_PARTS[rest[0]], ...rest.slice(1)];
  if (cmd === "activity") {
    const flag = rest.find((a) => Object.hasOwn(ACTIVITY_FLAGS, a));
    if (!flag) return ["changes", ...rest];
    const left = rest.filter((a) => a !== flag);
    // The writes viewer (audit) needs at least one option to tell it from `audit verify`.
    return flag === "--writes" && !left.some((a) => a.startsWith("--")) ? ["audit", "--since", "24h", ...left] : [ACTIVITY_FLAGS[flag], ...left];
  }
  if (cmd === "tidy") return rest[0] && Object.hasOwn(TIDY_JOBS, rest[0]) ? [TIDY_JOBS[rest[0]], ...rest.slice(1)] : ["tidy"];
  if (cmd === "settings" && rest[0] === "outside-window") return ["taint", ...rest.slice(1)];
  if (cmd !== undefined && Object.hasOwn(RENAMES, cmd)) return [RENAMES[cmd], ...rest];
  return null;
}

/** The one line an old name prints at a terminal, or null (a new name, or not a renamed command). */
export function oldNameNote(cmd: string, sub?: string): string | null {
  // `review keep <id>` and `review` itself are 1.6 words too; `history`, `archive`, `restore` were never renamed.
  if (!Object.hasOwn(OLD_COMMANDS, cmd)) return null;
  if (cmd === "stale" && sub !== "--code") return null;
  return `(monomem ${cmd} is now: monomem ${OLD_COMMANDS[cmd]}. The old name still works.)`;
}
