// `monomem why <id>`: the story of one note, in time order, from data Monomem already keeps (note history, change log,
// supersede log, held writes, receipts, distrust list, pin flag). Nothing new is recorded for it.
// Text rule: titles only (printed through printable()); a body only when the operator passes --body on the CLI.
import { isWriterMarker } from "./actor.js";
import { accessLogDays, type NoteRecord, type Store } from "./store.js";
import { describeWriter, printable, printableWords } from "./security.js";
import { localTime, whyText } from "./receipts.js";

export interface WhyEvent {
  at: string;
  what: string;
}
export interface WhyShown {
  session_id: string;
  at: string;
  client: string;
  rank: number;
  why: string;
}
export interface Why {
  id: number;
  namespace: string;
  title: string;
  status: "live" | "archived" | "superseded";
  /** The note's writer is on the distrust list (agents cannot read it; the operator can). */
  distrusted_writer: boolean;
  pinned: boolean;
  approve_first_namespace: boolean;
  created_by: { writer: string; kind: string };
  timeline: WhyEvent[];
  shown_to: { total: number; recent: WhyShown[]; retention_days: number };
  reads: { total: number; last: string | null; attributable: false };
  body?: string;
  not_recorded: string;
}

const SHOWN_LIMIT = 20;
export const NOT_RECORDED =
  "Not recorded: who read this note (only a total and the last read time are kept), when it was pinned or by whom, " +
  "the approval of a held write once it is approved, and versions older than the history limit or sessions older than the access-log retention.";

/** What a stored writer label is: a marker set by Monomem's own entry point, or a label from your config. */
export function writerKind(w: string, claimed = false): string {
  if (claimed) return "claimed by an import file, not verified";
  if (!w) return "unknown (written before writers were recorded)";
  if (w.startsWith("stdio:")) return "self-declared by its launch config, no sign-in";
  if (isWriterMarker(w)) return "server-stamped marker";
  return "token label, stamped by the server from the token";
}

const p = (v: unknown): string => printableWords(v, 80);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
/** A writer label in the same words the rest of Monomem uses (describeWriter), through printable(). */
const who = (w: string): string => p(describeWriter(w));

/** Build the story for a note the caller already read (and, for agents, already passed through the trust gate). */
export function noteWhy(store: Store, note: NoteRecord, opts: { namespaces?: string[]; body?: boolean } = {}): Why {
  const id = note.id;
  const db = store.captureDb();
  const tl: WhyEvent[] = [];
  const claimed = !!note.imported_unverified || !!note.imported_written_by;
  const creator = note.created_by || note.written_by;
  tl.push({
    at: note.created_at,
    what: `created by ${claimed ? `${p(creator || "unknown")} (${writerKind(creator, true)})` : who(creator)}${note.imported_created_by ? `; the import file claimed ${p(note.imported_created_by)}` : ""}`,
  });

  const hist = store.historyOf(id).reverse(); // oldest first
  for (const h of hist) {
    const by = h.imported ? `${p(h.written_by)} (${writerKind("", true)}${h.claimed_writer ? `: ${p(h.claimed_writer)}` : ""})` : who(h.written_by);
    // An earlier version by a distrusted writer is as hidden as the note itself would be: no title.
    const hidden = store.isDistrusted({ namespace: note.namespace, written_by: h.written_by, merged_from_writers: h.merged_from });
    const title = hidden ? "title hidden: its writer is distrusted" : `"${p(h.title)}"`;
    tl.push({ at: h.saved_at, what: `version ${h.version} (${title}, written by ${by}) replaced by ${who(h.saved_by)}, reason: ${p(h.reason)}` });
  }
  const dropped = store.historyDropped(id).reduce((a, d) => a + Number(d.count), 0);
  if (dropped) tl.push({ at: note.updated_at, what: `${dropped} older version${dropped === 1 ? "" : "s"} no longer kept` });
  if (note.rev > 1 || hist.length) tl.push({ at: note.updated_at, what: `version ${note.rev} is current, last written by ${who(note.written_by)}` });

  // Metadata-only changes (tags, archive, move): change-log rows whose revision did not move.
  const log = db.prepare("SELECT kind, rev, changed_at, actor FROM change_log WHERE note_id = ? ORDER BY seq").all(id) as Array<{ kind: string; rev: number | null; changed_at: string; actor: string }>;
  log.forEach((r, i) => {
    if (r.kind === "updated" && i > 0 && r.rev === log[i - 1].rev) tl.push({ at: r.changed_at, what: `metadata changed (tags, archive or move) by ${p(r.actor || "unknown")}` });
  });

  const sup = db.prepare("SELECT at, actor, action, old_id, new_id FROM supersede_log WHERE old_id = ? OR new_id = ? ORDER BY seq").all(id, id) as Array<{ at: string; actor: string; action: string; old_id: number; new_id: number | null }>;
  for (const s of sup) {
    const verb = s.action === "undo" ? "replacement undone" : "replaced";
    // The other note may be above the caller's sensitivity ceiling: then it is "another note", not an id.
    const other = s.old_id === id ? s.new_id : s.old_id;
    const otherName = other !== null && store.readVisible(other) ? `#${other}` : "another note";
    const rel = s.old_id === id ? `${verb}: this note was retired in favour of ${otherName}` : `${verb}: this note replaced ${otherName}`;
    tl.push({ at: s.at, what: `${rel}, by ${p(s.actor || "unknown")}` });
  }

  const held = db.prepare("SELECT written_by, reasons, created_at FROM quarantine WHERE target_id = ? ORDER BY id").all(id) as Array<{ written_by: string; reasons: string; created_at: string }>;
  for (const q of held) {
    let why = "";
    try {
      why = (JSON.parse(q.reasons) as Array<{ label: string }>).map((r) => p(r.label)).join(", ");
    } catch {
      /* unreadable reasons: say nothing rather than guess */
    }
    tl.push({ at: q.created_at, what: `an edit by ${p(q.written_by || "unknown")} is HELD, waiting for approval${why ? ` (${why})` : ""}` });
  }

  // Receipts: which session starts showed it (ids and tags only; kept for the access-log window).
  let shown: WhyShown[] = [];
  const hasReceipts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_receipts'").get();
  if (hasReceipts) {
    shown = (db.prepare("SELECT session_id, at, client, rank, why, namespace FROM memory_receipts WHERE note_id = ? ORDER BY at DESC").all(id) as unknown as Array<WhyShown & { namespace: string }>)
      .filter((r) => !opts.namespaces || opts.namespaces.includes(r.namespace))
      .map(({ session_id, at, client, rank, why }) => ({ session_id, at, client, rank: Number(rank), why }));
  }
  for (const r of shown.slice(0, SHOWN_LIMIT)) tl.push({ at: r.at, what: `shown at session start ${p(r.session_id)} (${p(r.client || "-")}), rank ${r.rank}, why: ${whyText(r.why)}` });

  tl.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); // stable: ties keep the order built above
  const status = note.status === "superseded" || note.superseded_by != null ? "superseded" : note.archived_at ? "archived" : "live";
  return {
    id,
    namespace: note.namespace,
    title: printable(note.title, 200),
    status,
    distrusted_writer: store.isDistrusted(note),
    pinned: !!note.pinned,
    approve_first_namespace: store.isApproveFirst(note.namespace),
    created_by: { writer: creator, kind: writerKind(creator, claimed) },
    timeline: tl,
    shown_to: { total: shown.length, recent: shown.slice(0, SHOWN_LIMIT), retention_days: accessLogDays() },
    reads: { total: note.access_count, last: note.last_accessed, attributable: false },
    ...(opts.body ? { body: note.body } : {}),
    not_recorded: NOT_RECORDED,
  };
}

/** `monomem why <id> [--json] [--body]` */
export async function whyCmd(args: string[]): Promise<void> {
  const raw = args.find((a) => !a.startsWith("-"));
  const id = raw && /^#?\d+$/.test(raw) ? Number(raw.replace("#", "")) : NaN;
  if (!Number.isInteger(id)) {
    console.error("Usage: monomem why <note-id> [--json] [--body]");
    process.exit(1);
  }
  const { DB_PATH } = await import("./config.js");
  const { Store } = await import("./store.js");
  const store = new Store(DB_PATH);
  try {
    const note = store.read(id); // gate-ok: local shell command (why): the operator owns the database file
    if (!note) {
      console.error(`no note #${id}`);
      process.exit(1);
    }
    const w = noteWhy(store, note, { body: args.includes("--body") });
    if (args.includes("--json")) return console.log(JSON.stringify(w, null, 2));
    console.log(`#${w.id} "${printable(w.title)}"  namespace ${printable(w.namespace)}`);
    for (const e of w.timeline) console.log(`  ${localTime(e.at)}  ${e.what}`);
    const flags = [w.pinned ? "pinned by the operator" : "", w.distrusted_writer ? "writer is distrusted: hidden from agents" : "", w.approve_first_namespace ? "namespace is approve-first" : ""].filter(Boolean);
    console.log(`status: ${w.status}${flags.length ? ` (${flags.join("; ")})` : ""}`);
    console.log(`shown at ${plural(w.shown_to.total, "session start")} (receipts kept ${w.shown_to.retention_days} days)`);
    console.log(`read ${plural(w.reads.total, "time")}${w.reads.last ? `, last ${localTime(w.reads.last)}` : ""}; who read it is not recorded`);
    if (w.body !== undefined) console.log(`body:\n${w.body.split("\n").map((l) => printable(l, 500)).join("\n")}`);
    console.log(w.not_recorded);
  } finally {
    store.close();
  }
}
