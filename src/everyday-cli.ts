// The everyday commands: add, show, ls, forget, edit. They are the same store calls every other writer uses, so the
// linter, secret refusal, quarantine, flood guard and history all apply. The CLI runs as the machine owner (the
// operator), so it is not limited by sensitivity ceilings; those limit apps, not you.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SENSITIVITY_LEVELS } from "./sensitivity.js";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Splits `--flag value` / `--flag=value` / boolean flags from the free words. */
export function parseArgs(args: string[], values: string[], bools: string[]): { flags: Record<string, string | true>; words: string[]; bad?: string } {
  const flags: Record<string, string | true> = {};
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-" || !a.startsWith("--")) {
      words.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = (eq > 0 ? a.slice(2, eq) : a.slice(2));
    if (bools.includes(name)) flags[name] = true;
    else if (values.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) return { flags, words, bad: `--${name} needs a value` };
      flags[name] = v;
    } else return { flags, words, bad: `Unknown option: ${a}` };
  }
  return { flags, words };
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function addCmd(args: string[]): Promise<void> {
  const usage = 'Usage: monomem add "text" [--title T] [--ns work] [--tag a,b] [--private | --sens public|internal|private]   ("-" reads the text from the keyboard or a pipe)';
  const { flags, words, bad } = parseArgs(args, ["title", "ns", "namespace", "tag", "tags", "sens", "sensitivity"], ["private", "help"]);
  if (bad) fail(`${bad}\n${usage}`);
  if (flags.help) return void console.log(usage);
  let text = words.join(" ");
  if (text === "-") text = readStdin();
  if (!text.trim()) fail(usage);
  const sens = flags.private ? "private" : ((flags.sens ?? flags.sensitivity) as string | undefined);
  if (flags.private && (flags.sens ?? flags.sensitivity) && flags.sens !== "private") fail("Use either --private or --sens, not both.");
  if (sens !== undefined && !(SENSITIVITY_LEVELS as readonly string[]).includes(sens)) fail(`--sens must be one of: ${SENSITIVITY_LEVELS.join(", ")}`);
  const title = typeof flags.title === "string" ? flags.title : text.replace(/\s+/g, " ").trim().slice(0, 60);
  const namespace = (flags.ns ?? flags.namespace) as string | undefined;
  const tagRaw = (flags.tag ?? flags.tags) as string | undefined;
  const tags = tagRaw ? tagRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError, QuarantinedError } = await import("./store.js");
  const store = new Store(DB_PATH);
  try {
    const n = store.create({ title, body: text, ...(namespace ? { namespace } : {}), ...(tags ? { tags } : {}), ...(sens ? { sensitivity: sens } : {}), source: "cli" });
    console.log(`Saved #${n.id} "${n.title}" in ${n.namespace}${n.sensitivity === "private" ? " (private)" : ""}.`);
    const sim = store.similarNote(n.id);
    if (sim) console.log(`Note: this looks similar to #${sim.id} "${sim.title}". If it is the same thing, update that one instead: monomem edit ${sim.id}`);
    if (n.sensitivity === "private") console.log("Limited apps cannot see this; apps with no limit (including your main Claude connection) still can.\nNext step: monomem connect <app> --max internal   (for the session hook: set MONOMEM_RECALL_MAX_SENSITIVITY=internal)");
  } catch (e) {
    if (e instanceof QuarantinedError) {
      console.log(`Held, not saved: ${e.message}. Review it with: monomem quarantine`);
      process.exit(3);
    }
    if (e instanceof ValidationError) fail(`Not saved: ${e.message}`);
    throw e;
  } finally {
    store.close();
  }
}

export async function showCmd(args: string[]): Promise<void> {
  const id = Number(args.find((a) => !a.startsWith("--")));
  if (!Number.isInteger(id) || id < 1) fail("Usage: monomem show <id> [--json]");
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { printable, printableBlock } = await import("./security.js");
  const store = new Store(DB_PATH);
  try {
    const n = store.readVisible(id, { includeDistrusted: true }); // local shell: the machine owner
    if (!n) fail(`No note #${id}.`);
    if (args.includes("--json")) return void console.log(JSON.stringify(n, null, 2));
    console.log(`#${n.id} [${printable(n.namespace, 100)}] ${printable(n.title)}${n.archived_at ? "  (archived)" : ""}`);
    console.log(`label: ${n.sensitivity ?? "internal"}   tags: ${printable(n.tags.join(", "), 400) || "none"}   written by: ${printable(n.written_by || "unknown", 80)}   version ${n.rev}`);
    console.log(`updated: ${n.updated_at}`);
    console.log("");
    console.log(printableBlock(n.body, 20000));
  } finally {
    store.close();
  }
}

export async function lsCmd(args: string[]): Promise<void> {
  const { flags, bad } = parseArgs(args, ["ns", "namespace", "limit"], ["json"]);
  if (bad) fail(`${bad}\nUsage: monomem ls [--ns x] [--limit 20] [--json]`);
  const limit = flags.limit === undefined ? 20 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a whole number, 1 or more.");
  const ns = (flags.ns ?? flags.namespace) as string | undefined;
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const { printable } = await import("./security.js");
  const store = new Store(DB_PATH);
  try {
    const notes = store.list({ ...(ns ? { namespace: ns } : {}), limit }).notes;
    if (flags.json) return void console.log(JSON.stringify(notes.map((n) => ({ id: n.id, namespace: n.namespace, title: n.title, updated_at: n.updated_at, sensitivity: n.sensitivity ?? "internal" })), null, 2));
    if (!notes.length && ns) {
      const used = store.rebuildPlan().map((r) => printable(r.namespace, 100));
      return void console.log(`No notes in namespace "${printable(ns, 100)}". ${used.length ? `Namespaces in use: ${used.slice(0, 30).join(", ")}${used.length > 30 ? ", ..." : ""}` : "There are no notes in any namespace yet."}`);
    }
    if (!notes.length) return void console.log("No notes yet. Add one with: monomem add \"something worth remembering\"");
    for (const n of notes) console.log(`#${n.id} [${printable(n.namespace, 100)}] ${printable(n.title, 70)}${n.sensitivity === "private" ? "  (private)" : ""}`);
  } finally {
    store.close();
  }
}

export async function editCmd(args: string[]): Promise<void> {
  const id = Number(args.find((a) => !a.startsWith("--")));
  if (!Number.isInteger(id) || id < 1) fail("Usage: monomem edit <id>   (opens the note in $VISUAL or $EDITOR)");
  // VISUAL, then EDITOR, then the editor every system has (notepad on Windows, vi elsewhere).
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
  const { DB_PATH } = await import("./config.js");
  const { Store, ValidationError, QuarantinedError } = await import("./store.js");
  const store = new Store(DB_PATH);
  const dir = mkdtempSync(join(tmpdir(), "monomem-edit-"));
  // No process.exit inside the try: the finally must always delete the temp copy of the note.
  const stop = (msg: string, code = 1): void => {
    (code === 3 ? console.log : console.error)(msg);
    process.exitCode = code;
  };
  try {
    const n = store.readVisible(id, { includeDistrusted: true });
    if (!n) return stop(`No note #${id}.`);
    const file = join(dir, `note-${id}.md`);
    writeFileSync(file, `${n.title}\n\n${n.body}`, { mode: 0o600 });
    // One command string through the shell (the editor setting may carry its own arguments, like "code --wait"), with the
    // file path double-quoted so a folder with a space in it stays one argument. No args array: that is what Node's
    // DEP0190 warns about with shell: true. The path is our own temp file, so it holds no quote character.
    const r = spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true });
    if (r.error || r.status !== 0) {
      const hint = process.platform === "win32" ? "in PowerShell: $env:EDITOR = 'notepad'" : "for example: export EDITOR=nano";
      return stop(`The editor (${editor}) did not start or did not finish normally; nothing was changed. To pick another one, ${hint}`);
    }
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const cut = text.indexOf("\n");
    const title = (cut < 0 ? text : text.slice(0, cut)).trim();
    const body = cut < 0 ? "" : text.slice(cut).replace(/^\n+/, "").replace(/\s+$/, "");
    if (!title) return stop("The first line is the title and it cannot be empty; nothing was changed.");
    if (title === n.title && body === n.body.replace(/\s+$/, "")) return void console.log("No changes.");
    try {
      const next = store.update(id, { title, body }, { ifRev: n.rev }); // if_rev: refuses if someone else changed it meanwhile
      console.log(`Saved #${id} (version ${next?.rev}).`);
    } catch (e) {
      if (e instanceof QuarantinedError) {
        return stop(`Held, not saved: ${e.message}. Review it with: monomem quarantine`, 3);
      }
      if (e instanceof ValidationError) return stop(`Not saved: ${e.message}`);
      throw e;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    store.close();
  }
}
