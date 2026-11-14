// Structured facts: an agent states a decision as key/value pairs when it writes ("deploy_target": "render").
// Stored as plain tags `fact:<key>=<value>`: no schema change, and the tag path already runs the secret / injection scan,
// the size limits and history. `fact:` is NOT a reserved prefix: any writer may edit tags, so reserving it would protect nothing.
// Matching is exact (same namespace + same key, different value), so a flagged pair is a real disagreement by construction.
// What it cannot know: whether two notes mean the same subject when an agent reuses one key for two things. Use a common key
// (COMMON_FACT_KEYS) when one fits, and prefix a subject ("api.deploy_target") only when the project has several.
import type { Store, NoteRecord } from "./store.js";
import { ValidationError } from "./store.js";
import { printable } from "./security.js";
import { actorStore } from "./actor.js";
import { heldFromSessionStart } from "./taint.js";
import { gatePinned } from "./operator-gate.js";
import { factMismatchWarnings, scanForInjection, scanForDirective } from "./lint.js";

export const FACT_PREFIX = "fact:";
export const MAX_FACTS = 10;
export const MAX_FACT_VALUE = 80;
const KEY_RE = /^[a-z0-9_.-]{1,40}$/;
const TAG_RE = /^fact:([a-z0-9_.-]{1,40})=(.{1,80})$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/; // same set the tag path refuses

/**
 * A fact value is a setting ("render", "pnpm"), not a sentence. Besides the injection and directive scans it refuses what the
 * scans do not know about but a setting never needs: a claim that the user approved something, a command to run, a script path.
 * Returns the reason, or null. Deterministic regexes: a reworded attack can pass (see SECURITY.md).
 */
export function flaggedFactValue(v: string): string | null {
  return (
    scanForInjection(v) ??
    scanForDirective(v) ??
    (/\b(?:user|admin|owner|operator|human)\s+(?:has\s+|already\s+)?(?:approved|authori[sz]ed|confirmed|allowed|said|asked)\b/i.test(v) ? "approval claim" : null) ??
    // A plain command is a legitimate fact value ("npm run build", "./scripts/deploy.sh"). Flag only the instruction shapes:
    // piping into a shell, a command chained after another value, or a command with urgency ("now", "without asking").
    (/[|;&]\s*(?:sh|bash|zsh|iex|pwsh|powershell)\b/i.test(v) ||
    (/[;]|&&/.test(v) && /\b(?:run|execute|exec|invoke|source|sudo|curl|wget)\b|\.(?:sh|ps1|bat|cmd|py)\b/i.test(v)) ||
    (/\b(?:now|immediately|right away|without asking|before anything|first thing)\b/i.test(v) && /\b(?:run|execute|exec|invoke|source|sudo|delete|send|upload)\b|\.(?:sh|ps1|bat|cmd|py)\b/i.test(v))
      ? "command or script"
      : null)
  );
}
export const WITHHELD = "[value withheld: flagged, see monomem conflicts]";

/** The keys agents are told to reuse, so two writers state one decision under one key. One list: the tool text, SKILL.md and the docs repeat it. */
export const COMMON_FACT_KEYS = ["deploy_target", "package_manager", "test_runner", "database", "node_version", "base_url", "ci_provider", "formatter"] as const;

// Spellings agents drift to. The first entry of each group is the common key. Deterministic: no model, no fuzzy matching.
const KEY_SYNONYMS: readonly (readonly string[])[] = [
  ["deploy_target", "hosting", "runs_on", "deploy_to", "deployment_target"],
  ["package_manager", "pkg_manager", "pkg_mgr", "package_mgr"],
  ["test_runner", "test_framework", "testing_framework", "test_tool"],
  ["database", "db", "datastore", "db_engine"],
  ["node_version", "node", "nodejs_version"],
  ["base_url", "api_url", "api_base_url", "site_url"],
  ["ci_provider", "ci", "ci_service", "ci_system"],
  ["formatter", "code_formatter", "format_tool"],
];

/** Same value, compared the way a person would: case and runs of spaces do not count. */
export const normFact = (v: string): string => v.toLowerCase().replace(/\s+/g, " ").trim();

/** Validate `facts` and return its tags. undefined -> []. Throws ValidationError. Secret / injection scanning happens when the tags are stored. */
export function factTags(facts: unknown): string[] {
  if (facts === undefined) return [];
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) throw new ValidationError('facts must be an object like {"deploy_target": "render"}');
  const entries = Object.entries(facts as Record<string, unknown>);
  if (entries.length > MAX_FACTS) throw new ValidationError(`too many facts (max ${MAX_FACTS})`);
  return entries.map(([k, v]) => {
    if (!KEY_RE.test(k)) throw new ValidationError(`fact key "${printable(k, 40)}" is not allowed: use 1-40 characters from a-z 0-9 _ . -`);
    if (typeof v !== "string" || !v.trim()) throw new ValidationError(`fact "${k}": the value must be a non-empty string`);
    if (v.trim().length > MAX_FACT_VALUE) throw new ValidationError(`fact "${k}": the value is longer than ${MAX_FACT_VALUE} characters`);
    if (CONTROL.test(v)) throw new ValidationError(`fact "${k}": the value must be one line of plain text`);
    const why = flaggedFactValue(v);
    if (why) throw new ValidationError(`fact "${k}": the value was refused (${why}). A fact is a setting like "render", not an instruction.`);
    return `${FACT_PREFIX}${k}=${v.trim()}`;
  });
}

/**
 * The tags to store when a write carries `facts`. No `facts` -> `tags` unchanged. With facts, they REPLACE the note's fact tags
 * (`facts: {}` clears them); on an update that passes no tags, the note's other existing tags are kept.
 */
export function withFacts(tags: string[] | undefined, facts: unknown, existing?: readonly string[]): string[] | undefined {
  if (facts === undefined) return tags;
  const add = factTags(facts);
  return [...(tags ?? existing ?? []).filter((t) => !t.startsWith(FACT_PREFIX)), ...add];
}

/** The facts a note carries (first tag wins per key). Tags that are not a valid fact are ignored. */
export function noteFacts(tags: readonly string[]): Array<[string, string]> {
  const out = new Map<string, string>();
  for (const t of tags) {
    const m = TAG_RE.exec(t.trim());
    if (m && !out.has(m[1]) && m[2].trim()) out.set(m[1], m[2].trim());
  }
  return [...out];
}

const writerOf = (n: NoteRecord): string => n.writer_id || n.written_by;
const MAX_REPORTED = 5;

const lastSegment = (k: string): string => k.slice(k.lastIndexOf(".") + 1);
const prefixOf = (k: string): string => k.slice(0, k.lastIndexOf(".") + 1);
const groupOf = (seg: string): readonly string[] | undefined => KEY_SYNONYMS.find((g) => g.includes(seg));
const quote = (v: string, max: number): string => flaggedFactValue(v) ? WITHHELD : `'${printable(v, max).replace(/'/g, "’")}'`;
/** "deploy_target" and "api.deploy_target" are one setting with a deliberate scope: never a drift pair. */
const scopedForm = (a: string, b: string): boolean => a.endsWith("." + b) || b.endsWith("." + a);

/** The common spelling of a key ("hosting" -> "deploy_target", "api.hosting" -> "api.deploy_target"); any other key is returned unchanged. */
export const canonKey = (key: string): string => {
  const g = groupOf(lastSegment(key));
  return g ? prefixOf(key) + g[0] : key;
};

/** Plural / one-edit spellings of one word ("deploy_targets", "deploy_targt"). Short words are skipped: "db" vs "dr" is not drift. */
function nearWord(a: string, b: string): boolean {
  if (a === b || a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  const [s1, l1] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s1.length && s1[i] === l1[i]) i++;
  // one substitution (same length) or one insertion (l1 is one longer): the rest must match
  return s1.slice(s1.length === l1.length ? i + 1 : i) === l1.slice(i + 1);
}

/** Keys that name the same setting as `key` by synonym ("hosting" for "deploy_target"), same prefix. Not `key` itself. */
function synonymKeys(key: string): string[] {
  const g = groupOf(lastSegment(key));
  return g ? g.filter((m) => m !== lastSegment(key)).map((m) => prefixOf(key) + m) : [];
}

/**
 * Right after a write: live notes from a DIFFERENT writer, in the same namespace, that state another value for one of this
 * note's fact keys, or for a synonym of it (hosting vs deploy_target). The write has already succeeded; these lines go back
 * to the agent so it can ask the user. Distrusted writers are skipped.
 */
export function writeConflicts(store: Store, note: NoteRecord): string[] {
  const mine = noteFacts(note.tags);
  if (!mine.length) return [];
  const out: string[] = [];
  for (const [key, value] of mine) {
    for (const theirKey of [key, ...synonymKeys(key)]) {
      for (const o of store.liveFactNotes(note.namespace, theirKey, note.id)) {
        const theirs = noteFacts(o.tags).find(([k]) => k === theirKey)?.[1];
        if (theirs === undefined || writerOf(o) === writerOf(note) || normFact(theirs) === normFact(value)) continue;
        const same = theirKey === key;
        out.push(`conflicts with #${o.id} by ${printable(o.written_by, 60)}: ${theirKey} ${quote(theirs, MAX_FACT_VALUE)} (theirs) vs ${same ? "" : key + " "}${quote(value, MAX_FACT_VALUE)} (yours)${same ? "" : ", the same setting under another key"}. Both are kept; ask the user which is right.`);
        if (out.length >= MAX_REPORTED) return out;
      }
    }
  }
  return out;
}

export interface SimilarKey { key: string; value: string; id: number; writer: string }

/**
 * Key drift: the fact keys of `note` that no other live note in its namespace uses yet, each with the existing keys that look
 * like the same thing (same last segment, or the same synonym group): key, current value, note id and writer, so the agent can reuse one.
 * A prefixed key against its own base key is deliberate scoping and is not reported. Deterministic. {} when none.
 */
export function similarKeys(store: Store, note: NoteRecord): Record<string, SimilarKey[]> {
  const mine = noteFacts(note.tags).map(([k]) => k);
  if (!mine.length) return {};
  const existing = new Map<string, SimilarKey>();
  for (const o of store.liveFactNotesIn(note.namespace)) {
    if (o.id === note.id) continue;
    for (const [k, v] of noteFacts(o.tags)) if (!existing.has(k)) existing.set(k, { key: k, value: v, id: o.id, writer: o.written_by });
  }
  const out: Record<string, SimilarKey[]> = {};
  for (const key of mine) {
    if (existing.has(key)) continue;
    const seg = lastSegment(key);
    const group = groupOf(seg);
    const rank = (k: string): number => (lastSegment(k) === group?.[0] ? 0 : 2) + (prefixOf(k) === prefixOf(key) ? 0 : 1);
    const like = [...existing.values()]
      .filter((e) => e.key !== key && !scopedForm(e.key, key) && (lastSegment(e.key) === seg || nearWord(lastSegment(e.key), seg) || (group !== undefined && group.includes(lastSegment(e.key)))))
      // The hint names the first one: the common key, then one with this key's prefix, beats a synonym.
      .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
      .slice(0, 3);
    if (like.length) out[key] = like;
  }
  return out;
}

/**
 * One sentence for the agent. It always steers toward the common key: "deploy_target is already 'render' (#1, stdio:claude). Use that
 * key if it's the same setting.", and never tells a writer that used the common key to switch to a synonym.
 */
export function similarHint(similar: Record<string, SimilarKey[]>): string {
  const [key, list] = Object.entries(similar)[0] ?? ["", []];
  const first = list[0];
  if (!first) return "";
  const seen = `${printable(first.key, 40)} is already ${quote(first.value, 40)} (#${first.id}, ${printable(first.writer, 40)})`;
  const canon = canonKey(key);
  if (canon === key && canonKey(first.key) !== first.key) return `${seen}, another spelling of ${printable(key, 40)}, the common key. Keep ${printable(key, 40)}.`;
  if (canonKey(first.key) !== first.key && canon !== first.key) return `${seen}, another spelling of ${printable(canon, 40)}, the common key. Use ${printable(canon, 40)} if it's the same setting.`;
  return `${seen}. Use that key if it's the same setting.`;
}

const MAX_DISPUTE_LINES = 2;
const MAX_SIDES = 3;
const MAX_WRITERS_SHOWN = 2;
export interface DisputeOpts { namespace?: string; writtenBy?: string; notWrittenBy?: string }
interface Side { shown: string; writers: Map<string, { name: string; id: number; key: string }> }
interface Dispute { namespace: string; key: string; sides: Side[] }

/**
 * The disputed settings of a set of live notes: one value per writer, strongest side (most writers) first, >= 2 sides.
 * Grouped by namespace + key; synonym spellings (hosting / deploy_target) are one setting under the common key.
 */
function disputes(notes: readonly NoteRecord[]): Dispute[] {
  const byKey = new Map<string, Map<string, Side>>();
  for (const n of notes) {
    for (const [rawKey, v] of noteFacts(n.tags)) {
      const gk = `${n.namespace}\u0000${canonKey(rawKey)}`;
      const vals = byKey.get(gk) ?? byKey.set(gk, new Map()).get(gk)!;
      const side = vals.get(normFact(v)) ?? vals.set(normFact(v), { shown: v, writers: new Map() }).get(normFact(v))!;
      const w = writerOf(n);
      if (!side.writers.has(w) || n.id < side.writers.get(w)!.id) side.writers.set(w, { name: n.written_by, id: n.id, key: rawKey });
    }
  }
  const minId = (s: Side): number => Math.min(...[...s.writers.values()].map((x) => x.id));
  const out: Dispute[] = [];
  for (const [gk, vals] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const sides = [...vals.values()].sort((a, b) => b.writers.size - a.writers.size || minId(a) - minId(b));
    // One value per writer: a writer who stated two values counts on the stronger side only, so one writer cannot fill both sides.
    const taken = new Set<string>();
    const kept: Side[] = [];
    for (const sd of sides) {
      const w = new Map([...sd.writers].filter(([id]) => !taken.has(id)));
      w.forEach((_, id) => taken.add(id));
      if (w.size) kept.push({ shown: sd.shown, writers: w });
    }
    const [namespace, key] = gk.split("\u0000");
    if (kept.length >= 2) out.push({ namespace, key, sides: kept });
  }
  return out;
}

/**
 * Session start: at most 2 short lines naming settings on which different writers' live notes disagree. Framed as a notice from Monomem,
 * values quoted, note ids and writers given, "+N more" when more are disputed than fit. Without a configured namespace
 * (undefined = every namespace) the line names the namespace. Never-show notes and distrusted writers are left out; the session's
 * writtenBy / notWrittenBy apply. A writer who changed their mind (old note still live) is one side, not two. "" when nothing is disputed.
 */
export function disputedLines(store: Store, opts: DisputeOpts | string = {}): string {
  const o: DisputeOpts = typeof opts === "string" ? { namespace: opts } : opts;
  // 1.4.0: a note held out of session start (unconfirmed outside content ...) must not reach it through its fact value either.
  const enforce = store.confirmSettings().mode === "enforce";
  const live = store.liveFactNotesIn(o.namespace, { writtenBy: o.writtenBy, notWrittenBy: o.notWrittenBy }).filter((n) => !heldFromSessionStart(n, enforce));
  const found = disputes(live);
  const lines = found.slice(0, MAX_DISPUTE_LINES).map(({ namespace, key, sides }) => {
    const text = sides.slice(0, MAX_SIDES).map((s) => {
      const ws = [...s.writers.values()].sort((a, b) => a.id - b.id);
      const shown = ws.slice(0, MAX_WRITERS_SHOWN).map((w) => `#${w.id} ${printable(w.name, 30)}${w.key !== key ? ` as ${printable(w.key, 40)}` : ""}`).join(", ");
      return `${quote(s.shown, 40)} (${shown}${ws.length > MAX_WRITERS_SHOWN ? `, +${ws.length - MAX_WRITERS_SHOWN}` : ""})`;
    }).join(" vs ");
    return `Monomem: writers disagree on ${o.namespace === undefined ? `[${printable(namespace, 40)}] ` : ""}${printable(key, 40)}: ${text}. Check with the user.`;
  });
  if (found.length > MAX_DISPUTE_LINES) lines[lines.length - 1] += ` (+${found.length - MAX_DISPUTE_LINES} more: monomem conflicts)`;
  return lines.join("\n");
}

export interface FactValue { value: string; writers: string[]; ids: number[]; since: string;
  /** Notes in `ids` whose writer has a newer note with another value for this key. */
  older: number[];
  /** This writer-with-several-values has this value as the newest one. */
  current: boolean }
export interface FactRow { key: string; disputed: boolean; agreed: boolean; values: FactValue[];
  /** Other spellings of the key that notes used ("db" under "database"), sorted. The row key is always the common key. */
  spellings: string[] }

const newestFirst = (a: NoteRecord, b: NoteRecord): number => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id);

/** `monomem facts`: per namespace, key -> current value(s) with writers and since. Disputed keys marked (synonym spellings count as one); keys two+ writers agree on marked too. */
export function factsTable(notes: readonly NoteRecord[]): Record<string, FactRow[]> {
  const out: Record<string, FactRow[]> = {};
  const byNs = new Map<string, NoteRecord[]>();
  for (const n of notes) (byNs.get(n.namespace) ?? byNs.set(n.namespace, []).get(n.namespace)!).push(n);
  for (const [ns, list] of [...byNs].sort(([a], [b]) => a.localeCompare(b))) {
    const disputedKeys = new Set(disputes(list).map((d) => d.key));
    type Entry = { value: string; writers: Set<string>; ids: number[]; since: string; older: number[]; current: boolean };
    const keys = new Map<string, Map<string, Entry>>();
    const spellings = new Map<string, Set<string>>();
    const stated = new Map<string, Array<{ n: NoteRecord; norm: string }>>(); // key + writer -> that writer's notes
    for (const n of list) {
      for (const [spelled, v] of noteFacts(n.tags)) {
        const k = canonKey(spelled); // synonym spellings share one row, under the common key
        (spellings.get(k) ?? spellings.set(k, new Set()).get(k)!).add(spelled);
        const vals = keys.get(k) ?? keys.set(k, new Map()).get(k)!;
        const e = vals.get(normFact(v)) ?? vals.set(normFact(v), { value: v, writers: new Set(), ids: [], since: n.updated_at, older: [], current: false }).get(normFact(v))!;
        e.writers.add(n.written_by);
        e.ids.push(n.id);
        if (n.updated_at < e.since) e.since = n.updated_at;
        const sk = `${k}\u0000${writerOf(n)}`;
        (stated.get(sk) ?? stated.set(sk, []).get(sk)!).push({ n, norm: normFact(v) });
      }
    }
    // A writer with several different values for one key: the newest is current, the others are older notes.
    const writersOfKey = new Map<string, Set<string>>();
    for (const [sk, mine] of stated) {
      const [key, w] = sk.split("\u0000");
      (writersOfKey.get(key) ?? writersOfKey.set(key, new Set()).get(key)!).add(w);
      mine.sort((a, b) => newestFirst(a.n, b.n));
      if (!mine.some((m) => m.norm !== mine[0].norm)) continue;
      keys.get(key)!.get(mine[0].norm)!.current = true;
      for (const m of mine) if (m.norm !== mine[0].norm) keys.get(key)!.get(m.norm)!.older.push(m.n.id);
    }
    out[ns] = [...keys].sort(([a], [b]) => a.localeCompare(b)).map(([key, vals]) => {
      const values = [...vals.values()].map((e) => ({ value: e.value, writers: [...e.writers].sort(), ids: e.ids.sort((a, b) => a - b), since: e.since, older: e.older.sort((a, b) => a - b), current: e.current }));
      const spelt = [...(spellings.get(key) ?? [])].filter((x) => x !== key).sort();
      return { key, disputed: disputedKeys.has(key), agreed: values.length === 1 && writersOfKey.get(key)!.size >= 2, values, spellings: spelt };
    });
  }
  return out;
}

export interface FactFeedback { conflicts?: string[]; similar_keys?: Record<string, SimilarKey[]>; hint?: string; fact_warnings?: string[] }

/** Everything a write that carried `facts` tells the writer: conflicts, key drift with a hint, and body/fact mismatches. {} when quiet. */
export function factFeedback(store: Store, note: NoteRecord): FactFeedback {
  const c = writeConflicts(store, note);
  const similar = similarKeys(store, note);
  const fw = factMismatchWarnings(note.title, note.body, note.tags);
  return { ...(c.length ? { conflicts: c } : {}), ...(Object.keys(similar).length ? { similar_keys: similar, hint: similarHint(similar) } : {}), ...(fw.length ? { fact_warnings: fw } : {}) };
}

const optVal = (args: string[], name: string): string | undefined => {
  const i = args.findIndex((a) => a === name || a.startsWith(name + "="));
  return i < 0 ? undefined : args[i].includes("=") ? args[i].slice(name.length + 1) : args[i + 1];
};
/** `monomem facts [--namespace ns] [--json] [--as-of t] [--check]` */
export async function factsCmd(args: string[]): Promise<void> {
  const usage = "Usage: monomem facts [--namespace ns] [--json] [--as-of <ISO|7d|2h>] [--check]";
  const ns = optVal(args, "--namespace");
  const asOf = optVal(args, "--as-of");
  // Exit codes for CI: 0 no dispute, 1 a dispute, 2 a usage or setup error (so a misconfigured run never passes as clean).
  if ((args.includes("--namespace") && !ns) || (args.includes("--as-of") && !asOf)) {
    console.error(usage);
    process.exit(2);
  }
  const { DB_PATH } = await import("./config.js");
  if (args.includes("--check")) {
    const { existsSync } = await import("node:fs");
    if (DB_PATH !== ":memory:" && !existsSync(DB_PATH)) {
      console.error(`facts check: no database at ${DB_PATH} (check MONOMEM_HOME / MONOMEM_DB_PATH)`);
      process.exit(2);
    }
  }
  const { Store: S } = await import("./store.js");
  const store = new S(DB_PATH);
  try {
    if (args.includes("--check")) {
      // For CI: the same disputes `monomem conflicts` lists at the fact tier (synonym spellings included). Exit 1 when there is one.
      const { findConflicts, groupConflicts } = await import("./conflicts.js");
      const groups = groupConflicts(findConflicts(store, { namespaces: ns ? [ns] : undefined }).filter((c) => c.tier === "fact"));
      if (!groups.length) console.log("facts check: no disputed facts.");
      else {
        console.log(`facts check: ${groups.length} disputed fact${groups.length === 1 ? "" : "s"}: ${groups.slice(0, 5).map((g) => `${printable(g.namespace, 40)}/${printable(g.key, 40)}`).join(", ")}${groups.length > 5 ? ", ..." : ""}. Run: monomem conflicts`);
        process.exitCode = 1;
      }
      return;
    }
    let notes: NoteRecord[];
    let when: Date | undefined;
    if (asOf) {
      const { parseAsOf, asOfView } = await import("./asof.js");
      when = parseAsOf(asOf);
      const view = asOfView(store, when, ns ? { namespace: ns } : {});
      // ponytail: the tags shown are the notes' current tags; a tag change that made no history row is not reconstructed (asof.ts says the same).
      notes = view.notes.filter((h) => h.kept).map((h) => h.note).filter((n) => noteFacts(n.tags).length);
    } else {
      notes = store.liveFactNotesIn(ns, { includeNeverShow: true });
    }
    const table = factsTable(notes);
    const asOfNote = when ? `As of ${when.toISOString()}: the notes that existed then, with their facts as tagged NOW (tag history is not kept, so a fact changed since shows its current value).` : "";
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ...(when ? { as_of: when.toISOString(), as_of_note: asOfNote } : {}), facts: table }, null, 2));
      return;
    }
    if (asOfNote) console.log(asOfNote);
    const spaces = Object.keys(table);
    if (!spaces.length) {
      console.log("No facts recorded. Agents record decisions with `facts` (deploy_target, package_manager ...).");
      return;
    }
    for (const space of spaces) {
      console.log(`\n[${printable(space)}]`);
      for (const r of table[space]) {
        const mark = r.disputed ? "  DISPUTED" : r.agreed ? `  (${r.values[0].writers.length > 1 ? r.values[0].writers.length : 2} writers agree)` : "";
        const also = r.spellings.length ? `  (also written as ${r.spellings.map((x) => printable(x, 40)).join(", ")})` : "";
        console.log(`  ${printable(r.key, 40)}${also}${mark}`);
        for (const v of r.values) {
          const cur = v.ids.filter((i) => !v.older.includes(i)).map((i) => `#${i}`);
          const old = v.older.map((i) => `older note #${i}`);
          console.log(`    ${printable(v.value, MAX_FACT_VALUE)}   by ${v.writers.map((w) => printable(w, 40)).join(", ")}   ${[...(cur.length ? [cur.join(",")] : []), ...old].join(", ")}${v.current ? "   (current)" : ""}   since ${v.since.slice(0, 10)}`);
        }
      }
    }
  } finally {
    store.close();
  }
}

/** `monomem fact remove <id> <key>`: drop one fact from a note (the note stays; it gets a fact-removed:<key> tag). Changes a note, so a pinned note needs the terminal confirmation like every other CLI edit of one. */
export async function factRemoveCmd(args: string[]): Promise<void> {
  const [sub, idRaw, key] = args;
  const id = Number(idRaw);
  if (sub !== "remove" || !Number.isInteger(id) || id < 1 || !key || !KEY_RE.test(key)) {
    console.error("Usage: monomem fact remove <note id> <key>");
    process.exit(1);
  }
  const { DB_PATH } = await import("./config.js");
  const { Store: S } = await import("./store.js");
  const store = new S(DB_PATH);
  try {
    const n = store.read(id); // gate-ok: local CLI, full trust like every command
    if (!n) {
      console.error(`no note with id ${id}`);
      process.exit(1);
    }
    const pre = `${FACT_PREFIX}${key}=`;
    if (!n.tags.some((t) => t.startsWith(pre))) {
      console.error(`#${id} has no fact "${key}"`);
      process.exit(1);
    }
    await gatePinned(store, [id], "fact remove");
    const mark = `fact-removed:${key}`;
    // The change log records who edited: the CLI, like the other `monomem` edits.
    actorStore.run({ label: "cli" }, () => store.update(id, { tags: [...n.tags.filter((t) => !t.startsWith(pre) && t !== mark), mark] }, {}));
    console.log(`Removed fact ${key} from #${id}. The note stays; its text may still mention the old value (find it with the tag ${mark}).`);
  } finally {
    store.close();
  }
}
