// `monomem supersede` and `monomem history`: the terminal side of replacing a memory (1.6.0).
//
//   monomem supersede --old 12[,13] --title "..." --body "..." [--tags a,b] [--confidence 0.8]
//   monomem supersede --old 12 --new-id 40
//       Shows the warning ("Are you sure you want to replace this?"). On a terminal it then asks you to TYPE the number of
//       notes you are replacing (or "yes"); anything else cancels and nothing changes. With no terminal (a script, a pipe)
//       it only shows the warning and prints a one-time code.
//   monomem supersede --confirm-token <code> [the same --title/--body/--tags/--confidence] [--acknowledge-risk]
//       The non-interactive way: only a code from a preview works, once, within minutes.
//   monomem supersede undo <id>
//   monomem history <id> [--json] [--include-distrusted]
//   monomem history restore <id> <version> [--if-rev n]
//   monomem history purge <id> [--yes]
//   monomem pin [<id>]  |  monomem unpin <id>
//   monomem rollback --writer <name> --since <iso|duration> [--include-conflicts] [--yes] [--json]
//
// There is deliberately NO --yes for a replacement: a script has to carry a code that was made by looking at a preview.
//
// The command line is the machine owner (the same trust as every other `monomem` command), so it runs with the admin scope
// under the writer name "cli". Everything goes through supersede.ts, like the REST and MCP surfaces.
import { readFileSync } from "node:fs";
import { Store, QuarantinedError, ValidationError } from "./store.js";
import { SupersedeError, supersedePreview, supersedeConfirm, supersedeUndo, supersedeTokenTargets, noteHistory, restoreVersion, purgeNoteHistory, type Caller } from "./supersede.js";
import type { SupersedeReplacementInput } from "./supersede-shared.js";
import { safe } from "./supersede-text.js";
import { maybeEmbed } from "./search-service.js";
import { rollbackPreview, rollbackConfirm, embedRestored } from "./rollback.js";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Ask one line on the terminal. Only called when `interactive` is true. */
  ask: (prompt: string) => Promise<string>;
  /** True only when a person is at a terminal (stdin AND stdout are TTYs). */
  interactive: boolean;
  /**
   * The operator gates (cli.ts: operator-gate.ts), called HERE with the ids this command will act on, as parsed by
   * parseArgs, so a gate and the action can never read different arguments. "pinned": ids it would change or retire;
   * "outside": the note it would promote (the replacement). Absent (library callers, tests) = no gate.
   */
  gate?: (kind: "pinned" | "outside", ids: number[], what: string) => Promise<void>;
}

const VALUE_FLAGS = ["old", "new-id", "title", "body", "body-file", "tags", "confidence", "confirm-token", "if-rev", "writer", "since"];
const BOOL_FLAGS = ["acknowledge-risk", "json", "include-distrusted", "yes", "include-conflicts"];

export function parseArgs(args: string[]): { flags: Record<string, string | true>; rest: string[] } {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
    if (name && VALUE_FLAGS.includes(name)) {
      // A repeated value flag is refused: "the last one wins" let a check read one value and the action use another.
      if (name in flags) throw new ValidationError(`--${name} was given more than once`);
      if (eq > 0) flags[name] = a.slice(eq + 1);
      else if (i + 1 < args.length) flags[name] = args[++i];
      else throw new ValidationError(`Missing value for --${name}`);
    } else if (name && BOOL_FLAGS.includes(name)) flags[name] = true;
    else if (a.startsWith("--")) throw new ValidationError(`Unknown option: ${a}`);
    else rest.push(a);
  }
  return { flags, rest };
}

const s = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function wholeNumbers(raw: string | undefined, what: string): number[] {
  if (!raw) throw new ValidationError(`${what} is required`);
  const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => /^\d+$/.test(p))) throw new ValidationError(`${what} must be note numbers like 12 or 12,13`);
  return parts.map(Number);
}

function newNoteFromFlags(flags: Record<string, string | true>): SupersedeReplacementInput | undefined {
  const title = s(flags.title);
  if (title === undefined) return undefined;
  const bodyFile = s(flags["body-file"]);
  const body = bodyFile ? readFileSync(bodyFile, "utf8") : s(flags.body);
  const conf = s(flags.confidence);
  const tags = s(flags.tags);
  return {
    title,
    body: body ?? "",
    ...(tags ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    ...(conf !== undefined ? { confidence: Number(conf) } : {}),
  };
}

/** Does what the person typed count as "yes, replace these N notes"? The note count, or yes. Nothing else. */
export function acceptsReplacement(answer: string, count: number): boolean {
  const a = answer.trim().toLowerCase();
  return a === "yes" || a === String(count);
}

export const RISK_PHRASE = "i accept the risk";

const OWNER: Caller = { scope: "admin" };

/** Run a supersede / history command. Returns the process exit code (0 done, 1 refused or failed, 2 preview only). */
export async function supersedeCli(store: Store, args: string[], io: CliIO, caller: Caller = OWNER): Promise<number> {
  try {
    const { flags, rest } = parseArgs(args);
    const json = flags.json === true;
    const emit = (v: unknown): void => io.out(JSON.stringify(v, null, 2));

    const gate = async (kind: "pinned" | "outside", ids: number[], what: string): Promise<void> => {
      const real = ids.filter((n) => Number.isInteger(n) && n > 0);
      if (io.gate && real.length) await io.gate(kind, real, what);
    };
    if (rest[0] === "undo") {
      await gate("pinned", [Number(rest[1])], "supersede");
      const out = supersedeUndo(store, caller, Number(rest[1]));
      if (json) emit(out);
      else io.out(out.message);
      return 0;
    }

    const token = s(flags["confirm-token"]);
    if (token !== undefined) {
      // The code names the notes: gate on those (the CLI's yes is recorded as a human confirm of the replacement).
      const t = supersedeTokenTargets(store, token);
      await gate("pinned", t.oldIds, "supersede");
      await gate("outside", [t.newId], "replacing notes with");
      const out = supersedeConfirm(store, caller, { token, new_note: newNoteFromFlags(flags), acknowledge_risk: flags["acknowledge-risk"] === true });
      await maybeEmbed(store, out.replacement);
      if (json) emit(out);
      else io.out(out.message);
      return 0;
    }

    const oldIds = wholeNumbers(s(flags.old), "--old");
    const newIdRaw = s(flags["new-id"]);
    const newNote = newNoteFromFlags(flags);
    if ((newNote === undefined) === (newIdRaw === undefined)) {
      throw new ValidationError("give exactly one of --title (with --body) for a new note, or --new-id for a note that already exists");
    }
    await gate("pinned", oldIds, "supersede");
    if (newIdRaw !== undefined) await gate("outside", [Number(newIdRaw)], "replacing notes with");
    const how = io.interactive
      ? "Type the number of notes you are replacing, or yes, to go ahead. Anything else cancels and nothing is changed."
      : "Nothing was changed. To go ahead from a script, run the same command again with --confirm-token {token} (and the same --title/--body).";
    const preview = supersedePreview(store, caller, { old_ids: oldIds, new_note: newNote, new_id: newIdRaw !== undefined ? Number(newIdRaw) : undefined }, how);
    if (json) {
      emit(preview);
      if (!io.interactive) return 2;
    } else io.out(preview.warning);

    if (!io.interactive) {
      if (!json) io.err("\nThis was only a preview: nothing was changed.");
      return 2;
    }
    const answer = await io.ask(`\nReplace ${preview.count} note${preview.count === 1 ? "" : "s"}? Type ${preview.count} or yes: `);
    if (!acceptsReplacement(answer, preview.count)) {
      io.out("Cancelled. Nothing was changed.");
      return 1;
    }
    let ack = false;
    if (preview.requires_acknowledgement) {
      const risk = await io.ask(`The warning above has a RED FLAG. To accept it type exactly: ${RISK_PHRASE}\n> `);
      if (risk.trim().toLowerCase() !== RISK_PHRASE) {
        io.out("Cancelled. Nothing was changed.");
        return 1;
      }
      ack = true;
    }
    const out = supersedeConfirm(store, caller, { token: preview.token, new_note: newNote, acknowledge_risk: ack });
    await maybeEmbed(store, out.replacement);
    io.out(out.message);
    return 0;
  } catch (e) {
    if (e instanceof QuarantinedError) {
      io.err(`Held for review (quarantine #${e.quarantineId}); nothing was replaced.`);
      return 1;
    }
    if (e instanceof SupersedeError || e instanceof ValidationError) {
      io.err(`Error: ${e.message}`);
      if (e instanceof SupersedeError && e.warning) io.err("\n" + e.warning);
      return 1;
    }
    throw e;
  }
}

/** `monomem history ...` */
export async function historyCli(store: Store, args: string[], io: CliIO, caller: Caller = OWNER): Promise<number> {
  try {
    const { flags, rest } = parseArgs(args);
    const json = flags.json === true;
    const sub = rest[0] === "restore" || rest[0] === "purge" ? rest[0] : "list";
    const idArg = sub === "list" ? rest[0] : rest[1];
    const id = Number(idArg);
    if (!Number.isInteger(id) || id < 1) throw new ValidationError("give a note number: monomem history <id> | history restore <id> <version> | history purge <id>");
    if (sub !== "list" && io.gate) await io.gate("pinned", [id], `history ${sub}`);
    if (sub === "list") {
      const h = noteHistory(store, caller, id, { includeDistrusted: flags["include-distrusted"] === true });
      if (json) {
        io.out(JSON.stringify(h, null, 2));
        return 0;
      }
      io.out(`Note ${id}: now at version ${h.current.version} ("${safe(h.current.title, 80)}", written by "${safe(h.current.written_by, 40)}").`);
      if (h.versions.length === 0) io.out("No earlier versions are kept.");
      for (const v of h.versions) {
        const who = v.written_by ? `written by "${safe(v.written_by, 40)}"` : v.claimed_writer ? `claimed to be written by "${safe(v.claimed_writer, 40)}" (unverified, came from an import)` : "writer unknown";
        io.out(`  version ${v.version}: "${safe(v.title, 80)}", ${who}, replaced ${v.saved_at.slice(0, 10)} by "${safe(v.saved_by, 40)}" (${v.reason})`);
        io.out(`      says: "${safe(v.body, 200)}"`);
      }
      if (h.hidden_by_trust_policy > 0) io.out(`${h.hidden_by_trust_policy} version(s) are hidden because their writer is on the distrust list (--include-distrusted shows them).`);
      return 0;
    }
    if (sub === "restore") {
      const version = Number(rest[2]);
      const ifRev = s(flags["if-rev"]);
      const out = restoreVersion(store, caller, id, version, ifRev !== undefined ? { ifRev: Number(ifRev) } : {});
      await maybeEmbed(store, out.note);
      io.out(json ? JSON.stringify(out, null, 2) : out.message);
      return 0;
    }
    // purge
    if (flags.yes !== true) {
      if (!io.interactive) throw new ValidationError("forgetting history cannot be undone: run it at a terminal and answer the question, or add --yes");
      const a = await io.ask(`Forget ALL earlier versions of note ${id}? This cannot be undone. Type yes: `);
      if (a.trim().toLowerCase() !== "yes") {
        io.out("Cancelled. Nothing was changed.");
        return 1;
      }
    }
    const out = purgeNoteHistory(store, caller, id);
    io.out(json ? JSON.stringify(out, null, 2) : out.message);
    return 0;
  } catch (e) {
    if (e instanceof QuarantinedError) {
      io.err(`Held for review (quarantine #${e.quarantineId}); the version was not restored.`);
      return 1;
    }
    if (e instanceof ValidationError) {
      io.err(`Error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

/** `monomem pin [<id>]` (no id: list) and `monomem unpin <id>`. Operator only: no MCP tool pins. */
export async function pinCli(store: Store, kind: "pin" | "unpin", args: string[], io: CliIO): Promise<number> {
  if (kind === "pin" && args.length === 0) {
    const list = store.pinnedNotes();
    if (list.length === 0) io.out("No note is pinned.");
    for (const n of list) io.out(`  note ${n.id} [${safe(n.namespace, 40)}] "${safe(n.title, 80)}"`);
    return 0;
  }
  const id = Number(args[0]);
  if (args.length !== 1 || !Number.isInteger(id) || id < 1) {
    io.err(`Usage: monomem ${kind === "pin" ? "pin [<id>]" : "unpin <id>"}`);
    return 1;
  }
  if (kind === "pin" && io.gate) await io.gate("outside", [id], "pinning");
  if (!store.setPinned(id, kind === "pin")) {
    io.err(`Error: no note with id ${id}`);
    return 1;
  }
  io.out(
    kind === "pin"
      ? `Note ${id} is pinned: agents can read it, but only the monomem CLI can change, archive, replace or restore it.`
      : `Note ${id} is no longer pinned.`
  );
  return 0;
}

/** `monomem rollback --writer <name> --since <iso|duration> [--include-conflicts] [--yes] [--json]` */
export async function rollbackCli(store: Store, args: string[], io: CliIO, caller: Caller = OWNER): Promise<number> {
  try {
    const { flags } = parseArgs(args);
    const json = flags.json === true;
    const how = flags.yes === true || io.interactive ? "" : "Nothing was changed. Run it again at a terminal, or add --yes, to go ahead.";
    const preview = rollbackPreview(store, caller, { writer: s(flags.writer), since: s(flags.since), include_conflicts: flags["include-conflicts"] === true }, how);
    io.out(json ? JSON.stringify(preview, null, 2) : preview.warning);
    if (preview.actions.length === 0) return 0;
    if (flags.yes !== true) {
      if (!io.interactive) return 2;
      const a = await io.ask(`
Roll back ${preview.actions.length} note(s)? Type yes: `);
      if (a.trim().toLowerCase() !== "yes") {
        io.out("Cancelled. Nothing was changed.");
        return 1;
      }
    }
    const out = rollbackConfirm(store, caller, { token: preview.token });
    await embedRestored(store, out);
    io.out(json ? JSON.stringify(out, null, 2) : out.message);
    return 0;
  } catch (e) {
    if (e instanceof QuarantinedError) {
      io.err(`A restored text was held for review (quarantine #${e.quarantineId}); nothing was rolled back.`);
      return 1;
    }
    if (e instanceof ValidationError) {
      io.err(`Error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
