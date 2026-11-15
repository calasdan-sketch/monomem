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
import { percentile } from "./retrieval-metrics.js";

/** Release gate (SPEC-round2, release gate 5): 10k encrypted session start p50 under this. */
export const GATE_MS = 50;
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
  /** runSearch keyword, 2-word query, one namespace, limit 10. */
  search: Timing;
  /** store.create with default options (similarity edges, linter) on the full store. */
  write: Timing;
  buildMs: number;
  dbMb: number;
  /** Rows whose body is an encryption envelope (0 for plain). */
  sealedBodies: number;
  /** C-06, encrypted only: the in-memory body index the search store builds (the session-start store never does). */
  bodyIndex?: { buildMs: number; notes: number; rssMb: number };
}
export interface ScaleReport {
  notes: number;
  plain: ModeTimings;
  encrypted: ModeTimings;
  /** Only at 10,000 notes or more. */
  gate: { thresholdMs: number; encryptedSessionStartP50: number; pass: boolean } | null;
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
function word(r: () => number): string {
  return VOCAB[Math.min(VOCAB.length - 1, Math.floor(1 / (r() + 1 / VOCAB.length)) - 1 + Math.floor(r() * 3))];
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

async function runMode(notes: number, encrypted: boolean, o: { iterations: number; writes: number }): Promise<ModeTimings> {
  const dir = join(BENCH_HOME, encrypted ? "scale-enc" : "scale-plain");
  mkdirSync(dir, { recursive: true });
  if (encrypted) ensureKey(dir); // the key file beside the DB is what turns encryption on
  const db = join(dir, "state.db");
  try {
    const r = rng(42);
    const t0 = performance.now();
    let store = new Store(db);
    try {
      // ponytail: bulk build skips similarity edges (as the retrieval bench does) so 10k builds in seconds; the timed writes
      // below keep edges on, so write cost is the real one.
      for (let done = 0; done < notes; done += 1000) {
        store.transaction(() => {
          for (let i = done; i < Math.min(notes, done + 1000); i++) {
            store.create(
              { namespace: NAMESPACES[i % NAMESPACES.length], title: words(r, 3 + Math.floor(r() * 5)), body: body(r), tags: [word(r)] },
              { skipEdges: true, lint: "none" }
            );
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
      const s = new Store(db, { bodyIndex: "off" }); // as the hook opens it
      try {
        await injectContext(s, { namespace: ns, signals });
      } finally {
        s.close();
      }
    });
    const hook = new Store(db, { bodyIndex: "off" });
    let session: number[];
    try {
      await injectContext(hook, { namespace: ns, signals }); // warm-up
      session = await timed(o.iterations, () => injectContext(hook, { namespace: ns, signals }));
    } finally {
      hook.close();
    }
    store = new Store(db); // a server's store: builds the body index (C-06) when encrypted
    try {
      // ponytail: RSS growth around the build is approximate (V8 may grow or shrink alongside); good to tens of MB.
      const rss0 = process.memoryUsage().rss;
      store.warmBodyIndex();
      const idx = store.bodyIndexInfo();
      const bodyIndex = idx.state === "ready" ? { buildMs: idx.buildMs, notes: idx.notes, rssMb: Math.round((process.memoryUsage().rss - rss0) / 1e5) / 10 } : undefined;
      const q = rng(7);
      const search = await timed(o.iterations * 5, () => runSearch(store, `${word(q)} ${word(q)}`, { mode: "keyword", namespace: ns, limit: 10 }));
      const w = rng(9);
      const write = await timed(o.writes, () => store.create({ namespace: ns, title: words(w, 5), body: body(w) }));
      return { sessionStart: timing(session), openAndSessionStart: timing(open), search: timing(search), write: timing(write), buildMs, ...dbFacts(store, db), ...(bodyIndex ? { bodyIndex } : {}) };
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

export async function runScale(o: { notes: number; iterations?: number; writes?: number }): Promise<ScaleReport> {
  const opts = { iterations: o.iterations ?? 30, writes: o.writes ?? 200 };
  const plain = await runMode(o.notes, false, opts);
  const encrypted = await runMode(o.notes, true, opts);
  const p50 = encrypted.sessionStart.p50;
  return {
    notes: o.notes,
    plain,
    encrypted,
    gate: o.notes >= 10000 ? { thresholdMs: GATE_MS, encryptedSessionStartP50: p50, pass: p50 < GATE_MS } : null,
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
  const row = (name: string, k: "sessionStart" | "openAndSessionStart" | "search" | "write"): void => {
    lines.push(`${name.padEnd(34)}${f(r.plain[k])} ${f(r.encrypted[k])}`);
  };
  row("session start (injectContext)", "sessionStart");
  row("open store + session start", "openAndSessionStart");
  row("keyword search, 2 words", "search");
  row("write (create, edges on)", "write");
  lines.push(`build: plain ${(r.plain.buildMs / 1000).toFixed(1)} s, encrypted ${(r.encrypted.buildMs / 1000).toFixed(1)} s; ` +
    `DB ${r.plain.dbMb} MB / ${r.encrypted.dbMb} MB`);
  const bi = r.encrypted.bodyIndex;
  if (bi) lines.push(`encrypted body search index (in memory, C-06): ${bi.notes} notes in ${(bi.buildMs / 1000).toFixed(2)} s, RSS +${bi.rssMb} MB`);
  if (r.gate) {
    lines.push(`release gate: ${r.notes}-note encrypted session start p50 ${r.gate.encryptedSessionStartP50.toFixed(1)} ms ` +
      `< ${r.gate.thresholdMs} ms: ${r.gate.pass ? "PASS" : "FAIL"}`);
  }
  return lines.join("\n");
}

export async function scaleMain(argv: string[], out: (s: string) => void = console.log): Promise<number> {
  try {
    const i = argv.indexOf("--scale");
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error("--scale needs a note count, for example --scale 10k");
    const r = await runScale({ notes: parseScale(v) });
    out(argv.includes("--json") ? JSON.stringify(r, null, 2) : renderScale(r));
    return r.gate && !r.gate.pass ? 1 : 0;
  } catch (e) {
    console.error(`bench: ${(e as Error).message}`);
    return 2;
  }
}
