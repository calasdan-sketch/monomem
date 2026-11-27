// Answer-accuracy benchmark with LOCAL models (Ollama): no paid API, no cloud. See docs/BENCHMARK.md, "Answer accuracy".
//
//   npm run build
//   node --max-old-space-size=6000 bench/answer-accuracy.mjs read   --dataset longmemeval --n 150 --out <dir>
//   node bench/answer-accuracy.mjs judge  --dataset longmemeval --n 150 --out <dir>
//   node bench/answer-accuracy.mjs report --dataset longmemeval --n 150 --out <dir>
//   node bench/answer-accuracy.mjs spot   --dataset longmemeval --n 150 --out <dir>   (20 verdicts to check by hand)
//
// Each condition (Monomem keyword top-5/10, optional hybrid, BM25-only, full history where it fits) gets the SAME reader,
// the SAME prompt and the SAME seeded sample. `read` and `judge` are resumable: results append to jsonl files in --out.
import "../dist/src/bench/retrieval-env.js"; // first: points MONOMEM_HOME at a throwaway folder
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/src/store.js";
import { runSearch, maybeEmbed } from "../dist/src/search-service.js";
import { embed, embeddingsEnabled } from "../dist/src/embeddings.js";
import { lmeDate, locomoDate } from "../dist/src/bench/retrieval.js";
import { LIMITS } from "../dist/src/security.js";
import { agreement, bm25Rank, judgePhase, normalizeLoCoMo, normalizeLongMemEval, paired, readPhase, renderTable, sampleItems, summarize } from "./answer-accuracy-lib.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : dflt;
};
const opt = {
  dataset: flag("dataset", "longmemeval"),
  n: Number(flag("n", "150")),
  seed: flag("seed", "monomem-acc-1"),
  reader: flag("reader", "qwen2.5:7b"),
  judge: flag("judge", "gemma4:12b"),
  numCtx: Number(flag("num-ctx", "32768")),
  ollama: flag("ollama", "http://localhost:11434"),
  out: flag("out", join(tmpdir(), "monomem-accuracy")),
  data: flag("data", ""),
  hybrid: rest.includes("--hybrid"),
  full: rest.includes("--full"),
};
const MAX_PROMPT_TOKENS = opt.numCtx - 2048; // leave room for the answer and for the 4-chars-a-token estimate being rough
const files = { answers: join(opt.out, "answers.jsonl"), verdicts: join(opt.out, `verdicts-${opt.judge.replace(/[^\w.-]/g, "_")}.jsonl`) };
const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const append = (f) => (rec) => appendFileSync(f, JSON.stringify(rec) + "\n");

async function chat(model, prompt, numPredict) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chatOnce(model, prompt, numPredict);
    } catch (e) {
      if (attempt >= 5) throw e; // the model server may restart or be busy loading another model
      await new Promise((r) => setTimeout(r, 20000));
    }
  }
}

async function chatOnce(model, prompt, numPredict) {
  const res = await fetch(`${opt.ollama}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, think: false, keep_alive: "10m", messages: [{ role: "user", content: prompt }], options: { temperature: 0, seed: 42, num_ctx: opt.numCtx, num_predict: numPredict } }),
  });
  if (!res.ok) throw new Error(`ollama ${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { text: String(j.message?.content ?? "").trim(), tokens: j.prompt_eval_count };
}

function loadItems() {
  const file = opt.data || join(homedir(), ".cache", "monomem-bench", opt.dataset === "locomo" ? "locomo10.json" : "longmemeval_s_cleaned.json");
  const data = JSON.parse(readFileSync(file, "utf8")); // untrusted: parsed as data only
  const all = opt.dataset === "locomo" ? normalizeLoCoMo(data) : normalizeLongMemEval(data);
  // Sample by question, then group by haystack so each conversation is indexed once.
  const picked = sampleItems(all, opt.seed, opt.n);
  return picked.sort((a, b) => (a.haystack < b.haystack ? -1 : a.haystack > b.haystack ? 1 : 0));
}

async function readCmd() {
  mkdirSync(opt.out, { recursive: true });
  const items = loadItems();
  let hybrid = opt.hybrid;
  if (hybrid && !(embeddingsEnabled() && (await embed("probe")))) {
    process.stderr.write("hybrid requested but no embedding server answered (set MONOMEM_EMBEDDINGS=on, MONOMEM_EMBED_URL): skipping hybrid\n");
    hybrid = false;
  }
  let store = null;
  let dir = "";
  let curHay = "";
  let unitOf = new Map();
  let byUnit = new Map();
  const close = () => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    store = null;
  };
  const beforeItem = async (item) => {
    if (item.haystack === curHay) return;
    close();
    curHay = item.haystack;
    dir = mkdtempSync(join(tmpdir(), "monomem-acc-"));
    process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log");
    store = new Store(join(dir, "state.db"));
    unitOf = new Map();
    byUnit = new Map(item.sessions.map((s) => [s.id, s]));
    const iso = (s) => (opt.dataset === "locomo" ? locomoDate(s) : lmeDate(s));
    const created = store.transaction(() =>
      item.sessions.map((s) => {
        const d = iso(s.date);
        const n = store.create({ title: s.id, body: s.text.slice(0, LIMITS.body), created_at: d }, { skipEdges: true, lint: "none", updatedAt: d });
        unitOf.set(n.id, s.id);
        return n;
      })
    );
    if (hybrid) for (const n of created) await maybeEmbed(store, n);
  };
  const viaMonomem = (mode, k) => async (item) => {
    const hits = await runSearch(store, item.question, { mode, limit: 50, asOf: item.qdate && opt.dataset !== "locomo" && lmeDate(item.qdate) ? new Date(lmeDate(item.qdate)) : undefined });
    const ids = [...new Set(hits.map((h) => unitOf.get(h.id)))].slice(0, k);
    return ids.map((id) => byUnit.get(id));
  };
  const viaBm25 = (k) => async (item) => bm25Rank(item.sessions, item.question, k).map((id) => byUnit.get(id));
  const conditions = [
    { name: "monomem-keyword-top5", retrieve: viaMonomem("keyword", 5) },
    { name: "monomem-keyword-top10", retrieve: viaMonomem("keyword", 10) },
    ...(hybrid ? [{ name: "monomem-hybrid-top5", retrieve: viaMonomem("hybrid", 5) }, { name: "monomem-hybrid-top10", retrieve: viaMonomem("hybrid", 10) }] : []),
    { name: "bm25-only-top5", retrieve: viaBm25(5) },
    { name: "bm25-only-top10", retrieve: viaBm25(10) },
    // Full history in rank-free order; skipped (and counted) when it does not fit the context window.
    ...(opt.full ? [{ name: "full-history", mustFit: true, retrieve: async (item) => item.sessions }] : []),
  ];
  const done = new Set(readJsonl(files.answers).map((r) => `${r.id}|${r.cond}`));
  let count = 0;
  const sink = append(files.answers);
  try {
    await readPhase({
      items, conditions, maxTokens: MAX_PROMPT_TOKENS, done, beforeItem,
      reader: (p) => chat(opt.reader, p, 128),
      onRecord: (r) => {
        sink(r);
        if (++count % 20 === 0) process.stderr.write(`${count} answers written (${r.id})\n`);
      },
    });
  } finally {
    close();
  }
  writeFileSync(join(opt.out, "run.json"), JSON.stringify({ ...opt, hybrid, maxPromptTokens: MAX_PROMPT_TOKENS, questions: items.length, date: new Date().toISOString(), node: process.version }, null, 2));
}

async function judgeCmd() {
  const items = loadItems();
  const done = new Set(readJsonl(files.verdicts).map((r) => `${r.id}|${r.cond}`));
  const sink = append(files.verdicts);
  await judgePhase({ records: readJsonl(files.answers), items, done, judge: async (p) => (await chat(opt.judge, p, 8)).text, onVerdict: sink });
}

function reportCmd() {
  const records = readJsonl(files.answers);
  const verdicts = readJsonl(files.verdicts);
  const rows = summarize(records, verdicts);
  const out = [`Dataset ${opt.dataset}, seed "${opt.seed}", n=${opt.n}; reader ${opt.reader}; judge ${opt.judge}; num_ctx ${opt.numCtx}; temperature 0, seed 42.`, "", renderTable(rows), ""];
  const base = rows.find((r) => r.cond === "bm25-only-top5") ? "bm25-only-top5" : rows[0]?.cond;
  for (const r of rows) if (base && r.cond !== base) {
    const p = paired(records, verdicts, r.cond, base);
    out.push(`${r.cond} vs ${base}: ${p.onlyA} questions only the first got right, ${p.onlyB} only the second (n=${p.n}), exact sign-test p=${p.p.toFixed(3)}`);
  }
  console.log(out.join("\n"));
}

function spotCmd() {
  // 20 verdicts, seeded, for a human to read. Hand labels go in <out>/hand.jsonl as {id,cond,verdict:true|false}.
  const records = readJsonl(files.answers).filter((r) => !r.skipped);
  const verdicts = readJsonl(files.verdicts);
  const byId = new Map(loadItems().map((i) => [i.id, i]));
  const pick = sampleItems(verdicts.map((v) => ({ ...v, id: `${v.id}|${v.cond}` })), `${opt.seed}-spot`, 20);
  const handFile = join(opt.out, "hand.jsonl");
  for (const v of pick) {
    const [id, cond] = v.id.split("|");
    const rec = records.find((r) => r.id === id && r.cond === cond);
    console.log(`--- ${id} | ${cond}\nQ: ${byId.get(id).question}\nGOLD: ${byId.get(id).answer}\nANSWER: ${rec.answer}\nJUDGE: ${v.verdict}\n`);
  }
  if (existsSync(handFile)) {
    const a = agreement(pick.map((v) => { const [id, cond] = v.id.split("|"); return { id, cond, verdict: v.verdict }; }), readJsonl(handFile));
    console.log(`judge vs hand labels: ${a.same}/${a.n} agree (${(100 * a.rate).toFixed(1)}%)`);
  }
}

const cmds = { read: readCmd, judge: judgeCmd, report: reportCmd, spot: spotCmd };
if (!cmds[cmd]) {
  console.error("usage: answer-accuracy.mjs read|judge|report|spot [--dataset longmemeval|locomo] [--n 150] [--seed S] [--reader M] [--judge M] [--hybrid] [--full] [--out DIR] [--data FILE]");
  process.exit(2);
}
await cmds[cmd]();
