// `monomem tasks`: the task board from a terminal (list / show / done / handoff), over the same task store the MCP
// memory_tasks tool uses (src/tasks.ts), so every check there applies. Quiet by default: open tasks, one line each.
// Task text is written by agents: it always goes through printable() before it reaches the terminal.

import { parseFlags } from "./shared.js";

const HELP = [
  "monomem tasks: the task board your agents keep.",
  "",
  "  tasks [list] [--all | --status <status>] [--owner <name>] [--ns <namespace>] [--json]",
  "        Open tasks (everything not done), overdue first, one line each. --all includes done ones.",
  "  tasks show <id> [--json]        one task in full: next step, notes, who wrote it",
  "  tasks done <id>                 mark a task done",
  "  tasks handoff [--json]          the latest handoff (what the last session finished and left open)",
  '  tasks handoff "summary" [--next "next step"] [--pending "a;b"] [--done "a;b"] [--ns <namespace>]',
  "        write a handoff for the next session (from: cli)",
  "",
  "Statuses: idea, planned, running, blocked, done, queued, failed. More: docs/tasks.md",
].join("\n");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const list = (v: string | true | undefined): string[] | undefined => (typeof v === "string" ? v.split(";").map((x) => x.trim()).filter(Boolean) : undefined);

export async function tasksCmd(args: string[]): Promise<void> {
  if (args.some((a) => a === "--help" || a === "-h") || args[0] === "help") return void console.log(HELP);
  const { flags, rest } = parseFlags(args, { values: ["status", "owner", "namespace", "next", "pending", "done", "limit"], bools: ["all", "json"] });
  const [sub = "list", ...words] = rest;
  if (!["list", "show", "done", "handoff"].includes(sub)) fail(`Unknown: monomem tasks ${sub}. Fix: see monomem tasks --help`);
  const { DB_PATH } = await import("../config.js");
  const { Store, ValidationError } = await import("../store.js");
  const { printable, printableBlock } = await import("../security.js");
  const { QuarantinedError } = await import("../errors.js");
  const t = await import("../tasks.js");
  const ns = typeof flags.namespace === "string" ? flags.namespace : undefined;
  const store = new Store(DB_PATH);
  const idArg = (): number => {
    const id = Number(String(words[0] ?? "").replace(/^#/, ""));
    if (!Number.isInteger(id) || id < 1) fail(`Usage: monomem tasks ${sub} <id>`);
    return id;
  };
  const marks = (x: { unconfirmed?: true; distrusted?: true }): string => (x.unconfirmed ? " (from outside, not confirmed)" : "") + (x.distrusted ? " (distrusted writer)" : "");
  try {
    if (sub === "list") {
      const status = flags.all ? "all" : typeof flags.status === "string" ? flags.status : undefined;
      const limit = typeof flags.limit === "string" ? Number(flags.limit) : 50;
      const { tasks, total } = t.listTasks(store, { status, owner: typeof flags.owner === "string" ? flags.owner : undefined, namespaces: ns ? [ns] : undefined, limit });
      if (flags.json) return void console.log(JSON.stringify({ tasks: tasks.map(t.compactTask), total }, null, 2));
      if (!tasks.length) return void console.log(status === "all" ? "No tasks." : "No open tasks.");
      for (const x of t.overdueFirst(tasks)) {
        const late = t.isOverdue(x.due) ? `, overdue since ${x.due}` : x.due ? `, due ${x.due}` : "";
        const who = x.owner ? `, ${printable(x.owner, 40)}` : "";
        const next = x.next_step ? `: next ${printable(x.next_step, 80)}` : "";
        console.log(`#${x.id} [${x.status}] ${printable(x.title, 80)}${next}${who}${late}${marks(x)}`);
      }
      if (total > tasks.length) console.log(`(${tasks.length} of ${total} shown: --limit ${Math.min(total, 200)} for more)`);
      return;
    }
    if (sub === "show") {
      const x = t.getTask(store, idArg(), ns ? [ns] : undefined);
      if (flags.json) return void console.log(JSON.stringify(x, null, 2));
      const line = (k: string, v: unknown): void => void (v !== "" && v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && console.log(`${k}: ${printable(Array.isArray(v) ? v.map((i) => `#${i}`).join(", ") : v, 200)}`));
      console.log(`#${x.id} ${printable(x.title, 200)}${marks(x)}`);
      line("Status", x.status);
      line("Owner", x.owner);
      line("Next step", x.next_step);
      line("Priority", x.priority);
      line("Due", x.due);
      line("Part of", x.parent_id === null ? "" : `#${x.parent_id}`);
      line("Waits for", x.blocked_by);
      line("Claimed by", x.lease ? `${x.lease.owner} until ${x.lease.expires_at}` : "");
      line("Command", x.command ? `${x.command.action} (approval: ${x.approval})` : "");
      line("Written by", x.written_by);
      line("Updated", x.updated_at);
      if (x.notes) console.log(`\n${printableBlock(x.notes, 20_000)}`);
      return;
    }
    if (sub === "done") {
      const id = idArg();
      const before = t.getTask(store, id, ns ? [ns] : undefined);
      if (before.status === "done") return void console.log(`Task #${id} was already done.`);
      const { task } = t.putTask(store, { id, status: "done", if_rev: before.rev }, ns ? { namespace: ns } : {});
      return void console.log(`Task #${task.id} "${printable(task.title, 80)}" is done.`);
    }
    // handoff
    const summary = words.join(" ").trim();
    if (!summary && !flags.next && !flags.pending && !flags.done) {
      const [h] = t.listHandoffs(store, { namespaces: ns ? [ns] : undefined, limit: 1 });
      if (flags.json) return void console.log(JSON.stringify(h ?? null, null, 2));
      if (!h) return void console.log('No handoff yet. Write one: monomem tasks handoff "what you finished" --next "what comes next"');
      console.log(`Handoff #${h.id} from ${printable(h.surface, 40)}, ${h.at.slice(0, 16).replace("T", " ")}${marks(h)}`);
      if (h.summary) console.log(`  ${printable(h.summary, 1000)}`);
      if (h.next_step) console.log(`  Next step: ${printable(h.next_step, 500)}`);
      for (const [name, items] of [["Done", h.done], ["Pending", h.pending], ["Decisions", h.decisions]] as const) if (items.length) console.log(`  ${name}: ${items.map((i) => printable(i, 200)).join("; ")}`);
      return;
    }
    const { handoff } = t.writeHandoff(store, { surface: "cli", summary, next_step: typeof flags.next === "string" ? flags.next : undefined, pending: list(flags.pending), done: list(flags.done), namespace: ns }, {});
    console.log(`Saved handoff #${handoff.id}. The next session start shows it.`);
  } catch (e) {
    if (e instanceof QuarantinedError) fail(`Held, not saved: ${e.message}. Review it with: monomem review held`);
    if (e instanceof ValidationError) fail(`Error: ${e.message}`);
    throw e;
  } finally {
    store.close();
  }
}
