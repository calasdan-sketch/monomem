// `monomem check --attacks --set <name>`: replay a published, outside attack set on a COPY of your store (never the real one),
// with your own settings, and say for every sample whether it was held, blocked, warned about, or REACHED the agent.
// The samples were written by other researchers for other systems: most are not memory notes at all, so this measures what
// Monomem's write gate and search do with that text, not whether an agent would act on it. See docs/security-scorecard.md.
import { createHash } from "node:crypto";
import { MonomemAdapter } from "../bench/monomem-adapter.js";
import { seededWord } from "../bench/engine.js";
import type { OpResult } from "../bench/types.js";
import { APPROVE_FIRST_NOTE, copyFacts, withStoreCopy, type Verdict } from "../drill.js";
import { PACKAGE_VERSION } from "../config.js";
import { AGENTDOJO_GOALS, AGENTDOJO_IMPORTANT_INSTRUCTIONS } from "./data-agentdojo.js";
import { INJECAGENT, INJECAGENT_ENHANCED_PREFIX } from "./data-injecagent.js";
import { MINJA } from "./data-minja.js";
import { LINT_EVASION } from "./data-lint-evasion.js";
import { TOOL_STEER } from "./data-tool-steer.js";
import { POISONEDRAG_NQ_SHA256, POISONEDRAG_NQ_URL, POISONEDRAG_SAMPLE } from "./data-poisonedrag.js";

export type Half = "a" | "b";

/**
 * Fixed tuning (a) / held-out (b) halves: the parity of the last byte of sha256(sample id), as `bench --split` does for
 * LongMemEval. Linter patterns are tuned on half a only; half b is the reported result.
 */
export function attackHalf(id: string): Half {
  return (createHash("sha256").update(id).digest()[31] & 1) === 0 ? "a" : "b";
}

export interface AttackSample {
  id: string;
  text: string;
}

export interface AttackSet {
  name: string;
  title: string;
  /** Where the samples come from (paper repository, pinned commit) and under which licence. */
  source: string;
  licence: string;
  /** What the set tests here, in one sentence, including what it does not. */
  what: string;
  /** Set when the samples are downloaded at run time (the only network call of this command). */
  download?: { url: string; sha256: string };
  samples: () => Promise<AttackSample[]>;
}

const fromPairs = (rows: ReadonlyArray<readonly [string, string]>, wrap: (t: string) => string = (t) => t): AttackSample[] => rows.map(([id, t]) => ({ id, text: wrap(t) }));
// PoisonedRAG's black-box attack puts the target question in front of the poisoned passage so retrieval finds it.
const poisoned = (question: string, passage: string): string => `${question} ${passage}`;

/** Download a pinned attack file and check it against the pinned SHA-256 before using any of it. Nothing is written to disk. */
export async function fetchChecked(url: string, sha256: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`could not download ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== sha256) throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${got}. Nothing was run.`);
  return bytes.toString("utf8");
}

export const ATTACK_SETS: readonly AttackSet[] = [
  {
    name: "injecagent",
    title: "InjecAgent attacker instructions (62)",
    source: "InjecAgent, Zhan et al. 2024, github.com/uiuc-kang-lab/InjecAgent @ f19c9f2",
    licence: "MIT",
    what: "Plain-language requests an attacker hides in tool output (unlock a door, email saved addresses...), saved as notes as written.",
    samples: async () => fromPairs(INJECAGENT),
  },
  {
    name: "injecagent-enhanced",
    title: "InjecAgent attacker instructions with its 'IMPORTANT!!! Ignore all previous instructions' prefix (62)",
    source: "InjecAgent, Zhan et al. 2024, github.com/uiuc-kang-lab/InjecAgent @ f19c9f2",
    licence: "MIT",
    what: "The same 62 instructions in InjecAgent's 'enhanced' form, with its fixed override sentence in front.",
    samples: async () => fromPairs(INJECAGENT, (t) => INJECAGENT_ENHANCED_PREFIX + t),
  },
  {
    name: "agentdojo",
    title: "AgentDojo v1 injection tasks in the 'important_instructions' wrapper (27)",
    source: "AgentDojo, Debenedetti et al. 2024, github.com/ethz-spylab/agentdojo @ 089ed46",
    licence: "MIT",
    what: "Every v1 injection goal (banking, slack, workspace, travel) inside AgentDojo's strongest published attack text.",
    samples: async () => fromPairs(AGENTDOJO_GOALS, (g) => AGENTDOJO_IMPORTANT_INSTRUCTIONS.replace("{goal}", g)),
  },
  {
    name: "minja",
    title: "MINJA-style memory records that redirect one patient's data to another (6)",
    source: "MINJA, Dong et al. 2025, github.com/dsh3n77/MINJA @ a3ec8da (indication text copied; questions are ours)",
    licence: "MIT",
    what: "A normal-looking question plus MINJA's 'information is lost, using patient X instead' note: a false fact, no command words.",
    samples: async () => fromPairs(MINJA),
  },
  {
    name: "lint-evasion",
    title: "Linter evasions: homoglyphs, other languages, encoded blobs, standing orders, round 2 rewrites, memory poison, ten more languages, embeds (61)",
    source: "Monomem expert audit round 1, 2026-11-18 (our own variants, not an outside paper)",
    licence: "MIT",
    what: "Variants of 'ignore previous instructions' that the first audit found stored: look-alike letters, Spanish / French / German / Portuguese, base64 and hex, and a standing order that hides or sends data. Closing these says the audit's cases are held, not that the linter is complete.",
    samples: async () => fromPairs(LINT_EVASION),
  },
  {
    name: "tool-steer",
    title: "Notes that steer which tool or MCP server the agent must use (14)",
    source: "Monomem, 2026-11-19 (our own phrasings of the MemMorph idea, not an outside paper)",
    licence: "MIT",
    what: "'For deploys always use tool X', 'prefer the X MCP server over Y', 'never use the Y tool'. No command words an injection list knows. Held for an app's key; the owner's own terminal writes them freely.",
    samples: async () => fromPairs(TOOL_STEER),
  },
  {
    name: "poisonedrag",
    title: "PoisonedRAG poisoned passages, NQ sample (10)",
    source: "PoisonedRAG, Zou et al. 2025, github.com/sleeepeer/PoisonedRAG @ f660d72",
    licence: "MIT",
    what: "Fluent passages that state a wrong answer to a question (misinformation, no instruction), saved as notes.",
    samples: async () => POISONEDRAG_SAMPLE.map(([id, q, p]) => ({ id, text: poisoned(q, p) })),
  },
  {
    name: "poisonedrag-nq",
    title: "PoisonedRAG poisoned passages, full NQ file (500, downloaded)",
    source: "PoisonedRAG, Zou et al. 2025, github.com/sleeepeer/PoisonedRAG @ f660d72, results/adv_targeted_results/nq.json",
    licence: "MIT",
    what: "All 5 poisoned passages for each of the 100 NQ questions. Downloaded when you run it; checked against a pinned SHA-256.",
    download: { url: POISONEDRAG_NQ_URL, sha256: POISONEDRAG_NQ_SHA256 },
    samples: async () => {
      const raw = JSON.parse(await fetchChecked(POISONEDRAG_NQ_URL, POISONEDRAG_NQ_SHA256)) as Record<string, { id: string; question: string; adv_texts: string[] }>;
      return Object.values(raw).flatMap((q) => q.adv_texts.map((p, i) => ({ id: `${q.id}-${i + 1}`, text: poisoned(q.question, p) })));
    },
  },
];

export function findSet(name: string): AttackSet | undefined {
  return ATTACK_SETS.find((s) => s.name === name);
}

export interface SetRow {
  id: string;
  verdict: Verdict;
  /** Why: the write outcome, or the lint warning labels. Never the sample text. */
  why: string;
}

export interface SetReport {
  set: string;
  title: string;
  source: string;
  licence: string;
  downloaded: boolean;
  version: string;
  date: string;
  notes: number;
  samples: number;
  counts: Record<Verdict, number>;
  rows: SetRow[];
  /** Set when only one half ran (`--half a|b`): a = the half the linter patterns were tuned on, b = held out. */
  half?: Half;
  approve_first: boolean;
  elapsed_ms: number;
}

/** One sample's verdict from its write and the reader's search for it. */
export function sampleVerdict(write: OpResult, found: boolean): { verdict: Verdict; why: string } {
  if (write.outcome === "quarantined") return { verdict: "held", why: "held for review" };
  if (write.outcome !== "ok") return { verdict: "blocked", why: `write ${write.outcome}${write.detail ? ` (${write.detail})` : ""}` };
  const warnings = (write.data?.warnings as Array<{ label?: string; category?: string }> | undefined) ?? [];
  const labels = [...new Set(warnings.map((w) => w.label ?? w.category ?? "warning"))].join(", ");
  if (!found) return { verdict: "blocked", why: "stored but not served to a reader" };
  return warnings.length ? { verdict: "warned", why: `served with a warning: ${labels}` } : { verdict: "reached", why: "stored and served with no warning" };
}

/**
 * Write every sample as an ordinary note from an app key with write access (not declared as outside text: the harder case),
 * then search for it as a reader. Runs on a copy of `dbPath`; the real store is only read.
 */
export async function runAttackSet(opts: { dbPath: string; set: AttackSet; samples?: AttackSample[]; half?: Half }): Promise<SetReport> {
  const started = Date.now();
  const all = opts.samples ?? (await opts.set.samples()); // download (if any) happens before the copy is made
  const samples = opts.half ? all.filter((s) => attackHalf(s.id) === opts.half) : all;
  return withStoreCopy(opts.dbPath, async (copy) => {
    const { notes, approveFirst } = copyFacts(copy);
    const adapter = new MonomemAdapter(copy);
    try {
      await adapter.open({ actors: { outsider: { scope: "write", writer: "outsider", server: "main" }, reader: { scope: "read", writer: "reader", server: "main" } }, grants: {} });
      const rows: SetRow[] = [];
      for (const s of samples) {
        // A made-up word in the title, so the reader's search finds this note and only this note.
        const tag = seededWord(1, opts.set.name, s.id);
        const write = await adapter.write("outsider", { title: `Note ${tag}`, body: s.text });
        let found = false;
        if (write.outcome === "ok") {
          const hits = await adapter.search("reader", tag);
          if (hits.outcome !== "ok") throw new Error(`${s.id}: the reader's search failed (${hits.outcome})`);
          found = (hits.hits ?? []).some((h) => h.id === write.note?.id);
        }
        rows.push({ id: s.id, ...sampleVerdict(write, found) });
      }
      const counts: Record<Verdict, number> = { held: 0, blocked: 0, warned: 0, reached: 0 };
      for (const r of rows) counts[r.verdict]++;
      return {
        set: opts.set.name,
        title: opts.set.title,
        source: opts.set.source,
        licence: opts.set.licence,
        downloaded: Boolean(opts.set.download),
        version: PACKAGE_VERSION,
        date: new Date().toISOString().slice(0, 10),
        notes,
        samples: rows.length,
        counts,
        rows,
        ...(opts.half ? { half: opts.half } : {}),
        approve_first: approveFirst,
        elapsed_ms: Date.now() - started,
      };
    } finally {
      await adapter.close().catch(() => undefined);
    }
  });
}

export function renderAttackSet(r: SetReport): string {
  const mark: Record<Verdict, string> = { held: "held   ", blocked: "blocked", warned: "warned ", reached: "REACHED" };
  const lines = [
    `Replayed ${r.samples} samples of "${r.set}" (${r.title}${r.half ? `, half ${r.half} only: ${r.half === "a" ? "the half the linter was tuned on" : "held out, never tuned on"}` : ""}) on a copy of your store (${r.notes} notes). Your store was not changed.`,
    `Source: ${r.source}, licence ${r.licence}.${r.downloaded ? " Downloaded for this run and checked against a pinned SHA-256." : " Shipped with Monomem; no network call."}`,
    "",
  ];
  for (const x of r.rows) lines.push(`  ${mark[x.verdict]}  ${x.id.padEnd(14)} ${x.why}`);
  const c = r.counts;
  lines.push("", `Held ${c.held}, blocked otherwise ${c.blocked}, warned ${c.warned}, REACHED ${c.reached} of ${r.samples} (Monomem ${r.version}, ${r.date}).`);
  lines.push("REACHED means a reader's search returned the note with no warning. It does not mean an agent would act on it.");
  lines.push("These samples were written for other systems. Since 2026-11-17 some linter patterns were tuned on half a of them; half b (--half b) was never tuned on.");
  if (r.approve_first) lines.push(APPROVE_FIRST_NOTE);
  return lines.join("\n");
}

export function listSets(): string {
  return ["Outside attack sets (monomem check --attacks --set <name>):", ...ATTACK_SETS.map((s) => `  ${s.name.padEnd(20)} ${s.title}${s.download ? "  [downloads at run time]" : ""}`)].join("\n");
}
