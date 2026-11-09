// Conflicts: two LIVE notes from DIFFERENT writers that disagree about the same thing ("deploy target: Fly.io" vs "deploy target: Render").
// FLAG ONLY: nothing is changed, hidden or merged. The human picks: supersede, pin one, or distrust a writer.
// Tier 1 (exact): both notes carry the same `fact:` key (facts.ts) with different values. Precision is 1.0 by construction,
//   as long as an agent keeps one key for one subject.
// Tier 2 (possible, deterministic, no model): "key: value" lines, a few tool families for "use X", identical or key-stating titles.
// ponytail: tier 2 is exact-key matching, so a paraphrase ("we host on Fly" vs "Hosting: Render") is missed on purpose; precision first.
import type { Store, NoteRecord } from "./store.js";
import { printable } from "./security.js";
import { noteFacts, normFact, canonKey } from "./facts.js";
import { writerKind } from "./why.js";

/** kind = what the label is (server-stamped marker or token label), so a spoofed "stdio" label is told apart from a token holder. */
export interface ConflictNote { id: number; title: string; writer: string; kind: string; pinned: boolean; at: string;
  /** How many OTHER facts the note carries besides the disputed key (Keep removes only the disputed one). */
  otherFacts: number;
  /** The fact key this note actually carries (a synonym such as "hosting" for a deploy_target group). Fact tier only. */
  factKey?: string }
export interface Conflict {
  namespace: string;
  /** Older first. */
  a: ConflictNote;
  b: ConflictNote;
  key: string;
  /** Lower-cased, as compared. */
  values: [string, string];
  /** As written (original case), for display. */
  shown: [string, string];
  /** fact: both notes carry the same fact key with different values. possible: the key:value / title rule. */
  tier: "fact" | "possible";
  /** exact (fact tier). high: both titles state the key and value. medium: identical titles, the values are in the bodies. */
  confidence: "exact" | "high" | "medium" | "low";
}

// "use X" tool families: two different members of one family under the same context conflict.
const FAMILIES: string[][] = [
  ["npm", "pnpm", "yarn", "bun"], ["jest", "vitest", "mocha", "ava"], ["postgres", "postgresql", "mysql", "sqlite", "mongodb"],
  ["fly.io", "render", "heroku", "vercel", "railway", "netlify"], ["tabs", "spaces"], ["prettier", "biome"],
  ["eslint", "biome"], ["pip", "poetry", "uv"], ["webpack", "vite", "esbuild", "rollup"], ["react", "vue", "svelte", "angular"],
];
const GENERIC_KEYS = new Set(["decision", "note", "notes", "summary", "todo", "context", "why", "status", "fix", "bug", "idea", "result", "update", "tip", "warning", "reminder", "question", "answer", "problem", "solution", "issue", "rule", "example", "see", "tldr", "http", "https"]);
const MAX_LINES = 40;

interface Stmt { key: string; value: string; shown: string; fromTitle: boolean }

const tidy = (v: string): string => v.replace(/[`*_"']/g, "").replace(/[.,;\s]+$/, "").replace(/\s+/g, " ").trim();
const clean = (v: string): string => tidy(v).toLowerCase();

function family(value: string): number {
  const w = value.split(/\s+/)[0];
  return FAMILIES.findIndex((f) => f.includes(w));
}

function stmtFrom(line: string, fromTitle: boolean): Stmt[] {
  // A match needs a key of <= 40 chars and a value of <= 60, so a longer line can never match. Skipping it also keeps a
  // planted line with a long whitespace run from making the lazy regex below quadratic (it froze the server for minutes).
  if (line.length > 200) return [];
  const out: Stmt[] = [];
  const m = /^\s*(?:[-*]\s+)?\**([A-Za-z][\w .\/-]{1,40}?)\**\s*(?::|=|->|→)\s*(?!\/\/)(.+?)\s*$/.exec(line);
  let rest = line.trim();
  if (m) {
    const key = clean(m[1]).replace(/^(the|our|project)\s+/, "");
    const value = clean(m[2]);
    const kw = key.split(" ").length;
    if (kw <= 4 && value && value.length <= 60 && value.split(" ").length <= 6) {
      if (!GENERIC_KEYS.has(key)) out.push({ key, value, shown: tidy(m[2]), fromTitle });
      else rest = value; // "Decision: use pnpm" -> look at what follows the label
    }
  }
  const u = /^(?:we |always |please )?(?:use|using|prefer|run)\s+([\w.\/-]+)(?:\s+(?:for|in|on|with)\s+([\w .-]{1,30}?))?[.!]?$/i.exec(rest);
  if (u) {
    const value = clean(u[1]);
    const fam = family(value);
    if (fam >= 0) out.push({ key: `use ${fam}${u[2] ? " " + clean(u[2]) : ""}`, value, shown: tidy(u[1]), fromTitle });
  }
  return out;
}

function statements(n: NoteRecord): Stmt[] {
  const out = stmtFrom(n.title, true);
  for (const line of n.body.split("\n").slice(0, MAX_LINES)) out.push(...stmtFrom(line, false));
  return out;
}

const writerOf = (n: NoteRecord): string => n.writer_id || n.written_by;
const brief = (n: NoteRecord, key?: string): ConflictNote => ({
  id: n.id,
  title: n.title,
  writer: n.written_by,
  kind: writerKind(n.written_by, !!n.imported_unverified || !!n.imported_written_by),
  pinned: n.pinned === true,
  at: n.updated_at,
  otherFacts: noteFacts(n.tags).filter(([k]) => k !== key).length,
  ...(key !== undefined ? { factKey: key } : {}),
});

// "fly.io" vs "fly.io (prod)" is a refinement, not a conflict; "npm" vs "pnpm" is (whole words, not substrings).
const valuesDiffer = (x: string, y: string): boolean => {
  const [a, b] = [x.split(" "), y.split(" ")].sort((m, n) => m.length - n.length);
  return !a.every((w) => b.includes(w));
};

const oldestFirst = <T extends { n: NoteRecord }>(x: T, y: T): [T, T] => (x.n.updated_at <= y.n.updated_at ? [x, y] : [y, x]);
const group = <T extends { n: NoteRecord }>(m: Map<string, T[]>, key: string, item: T): void => {
  (m.get(key) ?? m.set(key, []).get(key)!).push(item);
};

/** At most this many pairs: many notes sharing one key would otherwise make n^2 pairs and exhaust memory. */
export const MAX_CONFLICTS = 500;

export function findConflicts(store: Store, opts: { namespaces?: string[]; notes?: NoteRecord[] } = {}): Conflict[] {
  const { namespaces } = opts;
  const all = opts.notes ?? store.exportAll({ live: true }); // gate-ok: admin-only report
  // A distrusted writer's notes are never a "side" the operator is asked to weigh.
  const notes = store.filterVisible(all).filter((n) => (!namespaces || namespaces.includes(n.namespace)) && !n.archived_at && writerOf(n) && !n.unreadable);
  const out: Conflict[] = [];
  const done = new Set<string>();

  const facts = new Map<string, Array<{ n: NoteRecord; v: string; k: string }>>(); // synonym spellings (hosting / deploy_target) share a group
  for (const n of notes) for (const [k, v] of noteFacts(n.tags)) group(facts, `${n.namespace}\u0000${canonKey(k)}`, { n, v, k });
  factLoop: for (const [gk, g] of facts) {
    const key = gk.split("\u0000")[1];
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const [p, q] = oldestFirst(g[i], g[j]);
        if (writerOf(p.n) === writerOf(q.n) || normFact(p.v) === normFact(q.v)) continue;
        done.add(`${p.n.id}-${q.n.id}`);
        out.push({ namespace: p.n.namespace, a: brief(p.n, p.k), b: brief(q.n, q.k), key, values: [normFact(p.v), normFact(q.v)], shown: [p.v, q.v], tier: "fact", confidence: "exact" });
        if (out.length >= MAX_CONFLICTS) break factLoop;
      }
    }
  }

  const groups = new Map<string, Array<{ n: NoteRecord; s: Stmt }>>();
  for (const n of notes) {
    const seen = new Set<string>();
    for (const s of statements(n)) {
      const k = `${n.namespace}\u0000${s.key}`;
      if (seen.has(k)) continue; // a note that states a key twice is ambiguous: use its first statement
      seen.add(k);
      group(groups, k, { n, s });
    }
  }
  textLoop: for (const g of groups.values()) {
    if (out.length >= MAX_CONFLICTS) break;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const [p, q] = oldestFirst(g[i], g[j]);
        if (writerOf(p.n) === writerOf(q.n) || !valuesDiffer(p.s.value, q.s.value)) continue;
        const pair = `${p.n.id}-${q.n.id}`;
        if (done.has(pair)) continue;
        const both = p.s.fromTitle && q.s.fromTitle;
        // Same subject = both titles state the key, or the two titles are identical. ponytail: loosening this (shared words, key synonyms)
        // was measured: it finds paraphrases but floods the list with look-alike notes. Agents that want exact matching attach `facts`.
        const same = p.n.title.trim().toLowerCase() === q.n.title.trim().toLowerCase();
        if (!both && !same) continue;
        done.add(pair);
        out.push({ namespace: p.n.namespace, a: brief(p.n), b: brief(q.n), key: p.s.key.replace(/^use \d+/, "use").trim(), values: [p.s.value, q.s.value], shown: [p.s.shown, q.s.shown], tier: "possible", confidence: both ? "high" : "medium" });
        if (out.length >= MAX_CONFLICTS) break textLoop;
      }
    }
  }
  const rank = { exact: 0, high: 1, medium: 2, low: 3 };
  return out.sort((x, y) => rank[x.confidence] - rank[y.confidence] || x.a.id - y.a.id);
}

const quoted = (v: string): string => JSON.stringify(printable(v));

/** One disputed key: every value with the notes (and so the writers) that state it. */
export interface ConflictGroup {
  namespace: string;
  key: string;
  tier: "fact" | "possible";
  /** The strongest confidence of the pairs in the group. */
  confidence: "exact" | "high" | "medium" | "low";
  /** Most notes first. `value` is as written (original case). */
  values: Array<{ value: string; notes: ConflictNote[] }>;
}

const RANK = { exact: 0, high: 1, medium: 2, low: 3 };

/** Pairs -> one block per (namespace, key, tier), N values instead of N^2 pairs. Order follows the pairs. */
export function groupConflicts(conflicts: Conflict[]): ConflictGroup[] {
  const groups = new Map<string, { g: ConflictGroup; byValue: Map<string, { value: string; notes: Map<number, ConflictNote> }> }>();
  for (const c of conflicts) {
    const gk = `${c.tier}\u0000${c.namespace}\u0000${c.key}`;
    const e = groups.get(gk) ?? groups.set(gk, { g: { namespace: c.namespace, key: c.key, tier: c.tier, confidence: c.confidence, values: [] }, byValue: new Map() }).get(gk)!;
    if (RANK[c.confidence] < RANK[e.g.confidence]) e.g.confidence = c.confidence;
    for (const [i, n] of [c.a, c.b].entries()) {
      const v = e.byValue.get(c.values[i]) ?? e.byValue.set(c.values[i], { value: c.shown[i], notes: new Map() }).get(c.values[i])!;
      v.notes.set(n.id, n);
    }
  }
  return [...groups.values()].map(({ g, byValue }) => ({
    ...g,
    // A text-rule block that drags in more than two notes is a broad overlap, not a clear either/or: never "high" or "medium".
    ...(g.tier === "possible" && [...byValue.values()].reduce((n, v) => n + v.notes.size, 0) > 2 ? { confidence: "low" as const } : {}),
    values: [...byValue.values()].map((v) => ({ value: v.value, notes: [...v.notes.values()].sort((x, y) => x.id - y.id) })).sort((x, y) => y.notes.length - x.notes.length || x.notes[0].id - y.notes[0].id),
  }));
}

/** Most groups a report prints; the rest are counted. */
export const MAX_GROUPS_SHOWN = 50;

export interface ConflictReport { groups: ConflictGroup[]; total: number; capped: boolean }

/** Group, and cut to `limit` blocks. `capped`: the pair search hit MAX_CONFLICTS, so `total` is a lower bound ("at least"). */
export function conflictReport(pairs: Conflict[], limit = MAX_GROUPS_SHOWN): ConflictReport {
  const all = groupConflicts(pairs);
  return { groups: all.slice(0, limit), total: all.length, capped: pairs.length >= MAX_CONFLICTS };
}

/** "3 conflicts" / "showing 50 of 73 conflicts" / "showing 50 of at least 73 conflicts". */
export function reportHeader(r: ConflictReport): string {
  const n = r.groups.length;
  if (r.capped) return `showing ${n} of at least ${r.total} conflict${r.total === 1 ? "" : "s"}`;
  if (n < r.total) return `showing ${n} of ${r.total} conflicts`;
  return `${n} conflict${n === 1 ? "" : "s"}`;
}

/** Plain-text lines for the CLI; every title and value goes through printable(). The human picks the fix. */
export function conflictLines(groups: ConflictGroup[]): string[] {
  const out: string[] = [];
  for (const g of groups) {
    out.push(`\n[conflict:${g.confidence}] [${printable(g.namespace)}] ${printable(g.key)}`);
    for (const v of g.values) {
      out.push(`  ${printable(v.value)}`);
      for (const n of v.notes) out.push(`    #${n.id} "${printable(n.title)}" by ${printable(n.writer)} [${printable(n.kind)}] (${printable(n.at.slice(0, 10))})${n.pinned ? " [pinned]" : ""}`);
    }
    const noteCount = g.values.reduce((n, v) => n + v.notes.length, 0);
    if (noteCount > 3) out.push(`    ${noteCount} notes are involved: replacing them all at once is not suggested. Pin the one you trust (below), or replace two at a time.`);
    else for (const v of g.values) {
      const others = g.values.filter((o) => o !== v).flatMap((o) => o.notes.map((n) => n.id));
      if (others.length > 2) continue;
      out.push(`    keep ${printable(v.value)}: monomem supersede --old ${others.join(",")} --new-id ${v.notes[0].id}   (replaces ${others.length === 1 ? "note" : "notes"} ${others.join(", ")} whole)`);
    }
    if (g.tier === "fact") for (const v of g.values) out.push(`    or drop just the fact ${printable(v.value)}: ${v.notes.map((n) => `monomem fact remove ${n.id} ${printable(n.factKey ?? g.key)}`).join(" | ")}`);
    const all = g.values.flatMap((v) => v.notes);
    out.push(`    or pin one: ${all.map((n) => `monomem pin ${n.id}`).join(" | ")}`);
    const writers = [...new Set(all.map((n) => n.writer))];
    out.push(`    or distrust a writer: ${writers.map((w) => `monomem trust distrust ${quoted(w)} --namespace ${quoted(g.namespace)}`).join(" | ")}`);
  }
  return out;
}

/** `monomem conflicts [--json] [--namespace ns]` */
export async function conflictsCmd(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const i = args.findIndex((a) => a === "--namespace" || a.startsWith("--namespace="));
  const ns = i < 0 ? undefined : args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
  if (i >= 0 && !ns) {
    console.error("Usage: monomem conflicts [--json] [--namespace ns]");
    process.exit(1);
  }
  const { DB_PATH } = await import("./config.js");
  const { Store: S } = await import("./store.js");
  const store = new S(DB_PATH);
  try {
    const found = findConflicts(store, { namespaces: ns ? [ns] : undefined });
    const report = conflictReport(found);
    if (json) console.log(JSON.stringify({ conflicts: found, groups: report.groups, total: report.total, capped: report.capped }, null, 2));
    else if (!found.length) console.log("No conflicts found.");
    else {
      console.log(`${reportHeader(report)} (flagged only; nothing was changed)`);
      for (const l of conflictLines(report.groups)) console.log(l);
    }
  } finally {
    store.close();
  }
}
