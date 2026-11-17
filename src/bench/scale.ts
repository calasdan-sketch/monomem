// `monomem bench --scale 10k` (1.5.0 C-05): how fast session start, search and a write are on a big store, with and without
// at-rest encryption. The store is synthetic and lives in a temp folder (retrieval-env.ts); nothing real is opened.
import { BENCH_HOME } from "./retrieval-env.js"; // first: isolate MONOMEM_HOME before config.js loads
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureKey } from "../crypto.js";
import { Store } from "../store.js";
import { injectContext } from "../context-inject.js";
import { runSearch } from "../search-service.js";
import { PASSAGE_SETTING, passageCount, syncPassages } from "../store/passages.js";
import { percentile } from "./retrieval-metrics.js";
import { spawnSync } from "node:child_process";
import { selfCommand } from "../self.js";

/** Release gate (SPEC-round2, release gate 5): 10k encrypted session start p50 under this. */
export const GATE_MS = 50;
/** Release gate (r3 performance A10): 10k encrypted `monomem hook user-prompt`, whole process, prompt recall on, p50 under this. */
export const HOOK_GATE_MS = 250;
const NAMESPACES = ["alpha", "beta", "gamma", "delta", "epsilon"];

export interface Timing {
  p50: number;
  p95: number;
}
export interface ModeTimings {
  /** injectContext on an open store, one namespace (what the SessionStart hook runs after opening; bodyIndex off, as the hook). */
  sessionStart: Timing;
  /** A fresh Store + injectContext + close: closer to a hook process, minus Node start-up. */
  openAndSessionStart: Timing;
  /**
   * runSearch keyword, 2 words drawn from the Zipf vocabulary, one namespace, limit 10. Most draws are common words that
   * match most notes, so this is the costly case: keyword search cost grows with the number of matching notes.
   */
  search: Timing;
  /** The same, with 2 words each found in under 5% of the notes (most words in real notes; stop words are dropped). */
  searchRealistic: Timing;
  /** store.create with default options (similarity edges, linter) on the full store. */
  write: Timing;
  /**
   * `monomem hook user-prompt` as Claude Code runs it: a new process (Node start-up included) on the full store, with
   * MONOMEM_PROMPT_RECALL=on (the costlier path: the C17 prompt step runs too).
   */
  hookPrompt: Timing;
  buildMs: number;
  dbMb: number;
  /** Rows whose body is an encryption envelope (0 for plain). */
  sealedBodies: number;
  /** C-06, encrypted only: the in-memory body index the search store builds (the session-start store never does). */
  bodyIndex?: { buildMs: number; notes: number; rssMb: number };
  /** --passages, plain only: passage pooling switched on after the timings above, its index built, the searches re-timed. */
  passages?: { buildMs: number; passages: number; dbMbBefore: number; dbMbAfter: number; search: Timing; searchRealistic: Timing };
}
export interface ScaleReport {
  notes: number;
  plain: ModeTimings;
  encrypted: ModeTimings;
  /** Only at 10,000 notes or more. */
  gate: { thresholdMs: number; encryptedSessionStartP50: number; hookThresholdMs: number; encryptedHookPromptP50: number; pass: boolean } | null;
  node: string;
  date: string;
}

/** "10k" -> 10000, "2500" -> 2500. */
export function parseScale(s: string): number {
  const m = /^(\d+)(k?)$/i.exec(s.trim());
  const n = m ? Number(m[1]) * (m[2] ? 1000 : 1) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--scale must be a note count like 10k or 2500, got "${s}"`);
  return n;
}

/** Deterministic PRNG (mulberry32) so plain and encrypted runs get the same corpus. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pronounceable made-up words; Zipf-ish pick (rank ~ 1/u) so a few words are common and most are rare.
const SYL = ["ka", "lo", "mi", "ra", "ten", "vos", "pel", "dri", "un", "sor", "gan", "fi", "zu", "ber", "nol", "qua"];
const VOCAB = Array.from({ length: 3000 }, (_, i) => SYL[i % 16] + SYL[(i >> 4) % 16] + SYL[(i >> 8) % 16]);
export function word(r: () => number): string {
  // Clamped both ways: r() near 1 gives rank 0, and 0 - 1 + 0 would be index -1 (undefined; crashed runs from about 20k notes).
  return VOCAB[Math.max(0, Math.min(VOCAB.length - 1, Math.floor(1 / (r() + 1 / VOCAB.length)) - 1 + Math.floor(r() * 3)))];
}
const words = (r: () => number, n: number): string => Array.from({ length: n }, () => word(r)).join(" ");

/** Body sizes as in round2-performance.md: 80 % 200-600 chars, 15 % 1.5-3k, 5 % 8-20k. */
function body(r: () => number): string {
  const u = r();
  const chars = u < 0.8 ? 200 + r() * 400 : u < 0.95 ? 1500 + r() * 1500 : 8000 + r() * 12000;
  let s = "";
  while (s.length < chars) s += words(r, 12) + ".\n";
  return s.slice(0, chars);
}

const timing = (xs: number[]): Timing => ({ p50: percentile(xs, 50), p95: percentile(xs, 95) });

async function timed(n: number, f: (i: number) => unknown): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await f(i);
    out.push(performance.now() - t);
  }
  return out;
}

/** One `hook user-prompt` process per run, timed spawn to exit. Throws when the hook fails (a broken hook is not fast). */
function hookRuns(db: string, runs: number): number[] {
  const { command, args } = selfCommand(["hook", "user-prompt"]);
  const env = { ...process.env, MONOMEM_DB_PATH: db, MONOMEM_PROMPT_RECALL: "on" };
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const input = JSON.stringify({ session_id: `bench-${i}`, cwd: BENCH_HOME, hook_event_name: "UserPromptSubmit", prompt: `${word(rng(i))} deploy ${word(rng(i + 99))} config` });
    const t = performance.now();
    const r = spawnSync(command, args, { input, env, encoding: "utf8", timeout: 30_000 });
    out.push(performance.now() - t);
    if (r.status !== 0) throw new Error(`hook user-prompt exited ${r.status}: ${(r.stderr || String(r.error ?? "")).slice(0, 300)}`);
  }
  return out;
}

async function runMode(notes: number, encrypted: boolean, o: { iterations: number; writes: number; hookRuns: number; passages?: boolean }): Promise<ModeTimings> {
  const dir = join(BENCH_HOME, encrypted ? "scale-enc" : "scale-plain");
  mkdirSync(dir, { recursive: true });
  if (encrypted) ensureKey(dir); // the key file beside the DB is what turns encryption on
  const db = join(dir, "state.db");
  const auditLog = join(dir, "audit.log"); // beside its own key: plain and encrypted runs must not share one log (final3 PERF-L3)
  try {
    const r = rng(42);
    const t0 = performance.now();
    let store = new Store(db, { auditLog });
    const df = new Map<string, number>(); // notes each word appears in (the corpus is generated here, so it is counted here)
    try {
      // ponytail: bulk build skips similarity edges (as the retrieval bench does) so 10k builds in seconds; the timed writes
      // below keep edges on, so write cost is the real one.
      for (let done = 0; done < notes; done += 1000) {
        store.transaction(() => {
          for (let i = done; i < Math.min(notes, done + 1000); i++) {
            const note = { namespace: NAMESPACES[i % NAMESPACES.length], title: words(r, 3 + Math.floor(r() * 5)), body: body(r), tags: [word(r)] };
            store.create(note, { skipEdges: true, lint: "none" });
            for (const w of new Set(`${note.title} ${note.body} ${note.tags[0]}`.split(/[^a-z]+/))) if (w) df.set(w, (df.get(w) ?? 0) + 1);
          }
        });
      }
    } finally {
      store.close();
    }
    const buildMs = performance.now() - t0;
    const ns = NAMESPACES[0];
    const signals = { diffFiles: [] }; // no git: same work in every run
    const open = await timed(o.iterations, async () => {
      const s = new Store(db, { bodyIndex: "off", auditLog }); // as the hook opens it
      try {
        await injectContext(s, { namespace: ns, signals });
      } finally {
        s.close();
      }
    });
    const hookPrompt = timing(hookRuns(db, o.hookRuns));
    const hook = new Store(db, { bodyIndex: "off", auditLog });
    let session: number[];
    try {
      await injectContext(hook, { namespace: ns, signals }); // warm-up
      session = await timed(o.iterations, () => injectContext(hook, { namespace: ns, signals }));
    } finally {
      hook.close();
    }
    store = new Store(db, { auditLog }); // a server's store: builds the body index (C-06) when encrypted
    try {
      // ponytail: RSS growth around the build is approximate (V8 may grow or shrink alongside); good to tens of MB.
      const rss0 = process.memoryUsage().rss;
      store.warmBodyIndex();
      const idx = store.bodyIndexInfo();
      const bodyIndex = idx.state === "ready" ? { buildMs: idx.buildMs, notes: idx.notes, rssMb: Math.round((process.memoryUsage().rss - rss0) / 1e5) / 10 } : undefined;
      const q = rng(7);
      const search = await timed(o.iterations * 5, () => runSearch(store, `${word(q)} ${word(q)}`, { mode: "keyword", namespace: ns, limit: 10 }));
      const rare = [...df].filter(([, n]) => n < notes * 0.05).map(([w]) => w).sort();
      const pick = (): string => rare[Math.floor(q() * rare.length)] ?? word(q);
      const searchRealistic = await timed(o.iterations * 5, () => runSearch(store, `${pick()} ${pick()}`, { mode: "keyword", namespace: ns, limit: 10 }));
      let passages: ModeTimings["passages"];
      if (o.passages && !encrypted) {
        const dbMbBefore = dbFacts(store, db).dbMb;
        store.setMeta(PASSAGE_SETTING, "on");
        const tp = performance.now();
        syncPassages(store);
        const buildMs = performance.now() - tp;
        const dbMbAfter = dbFacts(store, db).dbMb;
        const q2 = rng(7); // the same query draws as above
        const pick2 = (): string => rare[Math.floor(q2() * rare.length)] ?? word(q2);
        const ps = await timed(o.iterations * 5, () => runSearch(store, `${word(q2)} ${word(q2)}`, { mode: "keyword", namespace: ns, limit: 10 }));
        const pr = await timed(o.iterations * 5, () => runSearch(store, `${pick2()} ${pick2()}`, { mode: "keyword", namespace: ns, limit: 10 }));
        passages = { buildMs, passages: passageCount(store), dbMbBefore, dbMbAfter, search: timing(ps), searchRealistic: timing(pr) };
      }
      const w = rng(9);
      const write = await timed(o.writes, () => store.create({ namespace: ns, title: words(w, 5), body: body(w) }));
      return { sessionStart: timing(session), openAndSessionStart: timing(open), search: timing(search), searchRealistic: timing(searchRealistic), write: timing(write), hookPrompt, buildMs, ...dbFacts(store, db), ...(bodyIndex ? { bodyIndex } : {}), ...(passages ? { passages } : {}) };
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function dbFacts(store: Store, db: string): { dbMb: number; sealedBodies: number } {
  store.checkpointWal();
  const raw = new DatabaseSync(db, { readOnly: true });
  try {
    const size = raw.prepare("SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()").get() as { b: number };
    const sealed = raw.prepare("SELECT COUNT(*) AS c FROM notes WHERE body_enc IS NOT NULL").get() as { c: number };
    return { dbMb: Math.round(size.b / 1e5) / 10, sealedBodies: sealed.c };
  } finally {
    raw.close();
  }
}

export async function runScale(o: { notes: number; iterations?: number; writes?: number; hookRuns?: number; passages?: boolean }): Promise<ScaleReport> {
  const opts = { iterations: o.iterations ?? 30, writes: o.writes ?? 200, hookRuns: o.hookRuns ?? 9, passages: o.passages };
  const plain = await runMode(o.notes, false, opts);
  const encrypted = await runMode(o.notes, true, opts);
  const p50 = encrypted.sessionStart.p50;
  const hookP50 = encrypted.hookPrompt.p50;
  return {
    notes: o.notes,
    plain,
    encrypted,
    gate: o.notes >= 10000 ? { thresholdMs: GATE_MS, encryptedSessionStartP50: p50, hookThresholdMs: HOOK_GATE_MS, encryptedHookPromptP50: hookP50, pass: p50 < GATE_MS && hookP50 < HOOK_GATE_MS } : null,
    node: process.version,
    date: new Date().toISOString(),
  };
}

export function renderScale(r: ScaleReport): string {
  const f = (t: Timing): string => `${t.p50.toFixed(1).padStart(7)} / ${t.p95.toFixed(1).padEnd(7)}`;
  const lines = [
    `Synthetic store: ${r.notes} notes in ${NAMESPACES.length} namespaces, temp folder, ${r.node}. ms, p50 / p95.`,
    `${"".padEnd(34)}${"plain".padEnd(18)}encrypted`,
  ];
  const row = (name: string, k: "sessionStart" | "openAndSessionStart" | "search" | "searchRealistic" | "write" | "hookPrompt"): void => {
    lines.push(`${name.padEnd(34)}${f(r.plain[k])} ${f(r.encrypted[k])}`);
  };
  row("session start (injectContext)", "sessionStart");
  row("open store + session start", "openAndSessionStart");
  row("keyword search, 2 common words", "search");
  row("keyword search, 2 realistic words", "searchRealistic");
  row("write (create, edges on)", "write");
  row("hook user-prompt, whole process", "hookPrompt");
  lines.push(`build: plain ${(r.plain.buildMs / 1000).toFixed(1)} s, encrypted ${(r.encrypted.buildMs / 1000).toFixed(1)} s; ` +
    `DB ${r.plain.dbMb} MB / ${r.encrypted.dbMb} MB`);
  const bi = r.encrypted.bodyIndex;
  if (bi) lines.push(`encrypted body search index (in memory, C-06): ${bi.notes} notes in ${(bi.buildMs / 1000).toFixed(2)} s, RSS +${bi.rssMb} MB`);
  const pp = r.plain.passages;
  if (pp) {
    lines.push(`passage pooling ON (plain): ${pp.passages} passages built in ${(pp.buildMs / 1000).toFixed(2)} s; DB ${pp.dbMbBefore} -> ${pp.dbMbAfter} MB (+${(((pp.dbMbAfter - pp.dbMbBefore) / pp.dbMbBefore) * 100).toFixed(0)} %)`);
    lines.push(`${"  keyword search, 2 common words".padEnd(34)}${f(pp.search)}`, `${"  keyword search, 2 realistic words".padEnd(34)}${f(pp.searchRealistic)}`);
  }
  lines.push("(common: drawn from a small Zipf vocabulary, most match most notes; realistic: each word in under 5% of notes. Keyword search cost grows with the notes that match, not the store size.)");
  if (r.gate) {
    lines.push(`release gate: ${r.notes}-note encrypted session start p50 ${r.gate.encryptedSessionStartP50.toFixed(1)} ms ` +
      `< ${r.gate.thresholdMs} ms; hook user-prompt p50 ${r.gate.encryptedHookPromptP50.toFixed(1)} ms < ${r.gate.hookThresholdMs} ms: ${r.gate.pass ? "PASS" : "FAIL"}`);
  }
  return lines.join("\n");
}

export async function scaleMain(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  try {
    const i = argv.indexOf("--scale");
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error("--scale needs a note count, for example --scale 10k");
    const r = await runScale({ notes: parseScale(v), passages: argv.includes("--passages") });
    out(argv.includes("--json") ? JSON.stringify(r, null, 2) : renderScale(r));
    return r.gate && !r.gate.pass ? 1 : 0;
  } catch (e) {
    console.error(`bench: ${(e as Error).message}`);
    return 2;
  }
}
