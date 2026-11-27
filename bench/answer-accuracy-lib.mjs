// Pure helpers for bench/answer-accuracy.mjs: no network, no Monomem import, so a unit test can drive the whole
// pipeline with a fake reader and judge (test/answer-accuracy.test.ts). Reader and judge are injected functions.
import { createHash } from "node:crypto";

export const estTokens = (s) => Math.ceil(s.length / 4); // rough: 4 characters a token; real counts come from the model server

/** Wilson score interval for k correct of n, as fractions. Returns [lo, hi]. */
export function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Exact two-sided sign-test p-value for b vs c discordant pairs (McNemar exact). */
export function signTestP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const m = Math.min(b, c);
  let logC = 0; // log C(n, i), built up
  let tail = 0;
  for (let i = 0; i <= m; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

/** Seeded, order-independent sample: sort by sha256(seed:id), take the first n. Same seed + same ids -> same sample. */
export function sampleItems(items, seed, n) {
  const key = (it) => createHash("sha256").update(`${seed}:${it.id}`).digest("hex");
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : 1)).slice(0, n);
}

const asText = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const rec = (v) => (v && typeof v === "object" ? v : {});

/** LongMemEval-S -> items. One haystack per question. Abstention (`_abs`) questions are skipped, as in the retrieval bench. */
export function normalizeLongMemEval(data) {
  const out = [];
  for (const q of Array.isArray(data) ? data : []) {
    const id = asText(q.question_id);
    const gold = (q.answer_session_ids ?? []).map(asText).filter(Boolean);
    if (!id || id.endsWith("_abs") || !gold.length || !q.question || q.answer == null) continue;
    const ids = q.haystack_session_ids ?? [];
    const dates = q.haystack_dates ?? [];
    const sessions = (q.haystack_sessions ?? []).map((s, i) => ({
      id: asText(ids[i]) || `session_${i}`,
      date: asText(dates[i]),
      text: (Array.isArray(s) ? s : []).map((t) => `${asText(rec(t).role)}: ${asText(rec(t).content)}`).join("\n"),
    }));
    out.push({ id, type: asText(q.question_type) || "unknown", question: asText(q.question), answer: asText(q.answer), qdate: asText(q.question_date), haystack: id, sessions, goldSessions: gold });
  }
  return out;
}

/** LoCoMo-10 -> items. One item per QA; all QAs of a conversation share `haystack`. Category 5 (no answer) is skipped. */
export function normalizeLoCoMo(data) {
  const out = [];
  (Array.isArray(data) ? data : []).forEach((sample, si) => {
    const conv = rec(sample.conversation);
    const hay = asText(sample.sample_id) || `conv${si}`;
    const sessions = [];
    for (const key of Object.keys(conv)) {
      const m = /^session_(\d+)$/.exec(key);
      if (!m) continue;
      const text = (Array.isArray(conv[key]) ? conv[key] : [])
        .map((t) => `${asText(rec(t).speaker)}: ${asText(rec(t).text)}${rec(t).blip_caption ? ` [shares image: ${asText(rec(t).blip_caption)}]` : ""}`)
        .join("\n");
      sessions.push({ id: `D${m[1]}`, date: asText(conv[`${key}_date_time`]), text });
    }
    (sample.qa ?? []).forEach((qa, i) => {
      const ev = (qa.evidence ?? []).flatMap((e) => asText(e).split(/[;,\s]+/)).filter((e) => /^D\d+:\d+$/.test(e));
      const gold = [...new Set(ev.map((e) => e.split(":")[0]))];
      if (!gold.length || !qa.question || qa.answer == null) return;
      out.push({ id: `${hay}#${i}`, type: `category ${asText(qa.category)}`, question: asText(qa.question), answer: asText(qa.answer), qdate: "", haystack: hay, sessions, goldSessions: gold });
    });
  });
  return out;
}

/** Plain Okapi BM25 over whole sessions. Lowercase [a-z0-9] tokens, no stemming, no stop list. Returns session ids, best first. */
export function bm25Rank(sessions, query, k = 10, k1 = 1.5, b = 0.75) {
  const tok = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const docs = sessions.map((s) => tok(s.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1) || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(tok(query))];
  const scored = sessions.map((s, i) => {
    const tf = new Map();
    for (const t of docs[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].length) / avg));
    }
    return { id: s.id, score, i };
  });
  return scored.sort((x, y) => y.score - x.score || x.i - y.i).slice(0, k).map((x) => x.id);
}

const sessionBlock = (s) => `### Session${s.date ? ` (${s.date})` : ""}\n${s.text}`;

/** Same prompt for every condition. `sessions` are in rank order; lowest-ranked are dropped until the estimate fits maxTokens. */
export function buildReaderPrompt(item, sessions, maxTokens) {
  const head = "I will give you several chat sessions. Please answer the question using only what they say. Answer in one short sentence or phrase. If the sessions do not contain the answer, say you do not know.\n\n";
  const tail = `\n\n${item.qdate ? `Current date: ${item.qdate}\n` : ""}Question: ${item.question}\nAnswer:`;
  let used = [...sessions];
  const render = () => head + "History:\n\n" + [...used].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map(sessionBlock).join("\n\n") + tail;
  let prompt = render();
  while (used.length > 1 && estTokens(prompt) > maxTokens) {
    used = used.slice(0, -1);
    prompt = render();
  }
  return { prompt, used: used.map((s) => s.id), dropped: sessions.length - used.length, fits: estTokens(prompt) <= maxTokens };
}

const JUDGE_BASE = "I will give you a question, a correct answer, and a response from a model. Answer yes if the response contains the correct answer. Otherwise answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get it, answer yes. If it only contains a subset of the needed information, or says it does not know, answer no.";
const JUDGE_EXTRA = {
  "temporal-reasoning": " Do not penalize off-by-one errors in a number of days, weeks or months.",
  "knowledge-update": " If the response also mentions the older value but gives the updated answer, answer yes.",
};

/** Judge prompt, adapted from the public LongMemEval judging instructions (wording is ours, not byte-identical). */
export function buildJudgePrompt(item, response) {
  const extra = JUDGE_EXTRA[item.type] ?? "";
  return `${JUDGE_BASE}${extra}\n\nQuestion: ${item.question}\nCorrect answer: ${item.answer}\nModel response: ${response}\n\nIs the model response correct? Answer yes or no.`;
}

/** First word yes -> true, no -> false, anything else -> null (counted as wrong and reported). */
export function parseVerdict(text) {
  const w = (/[a-z]+/i.exec(text.trim()) ?? [""])[0].toLowerCase();
  return w === "yes" ? true : w === "no" ? false : null;
}

/**
 * Retrieval + reader pass. conditions: [{ name, retrieve(item) -> sessions in rank order, mustFit? }]. `reader(prompt)` -> {text, tokens}.
 * `done` is a Set of "id|cond" already on disk. `onRecord` receives each new record (the CLI appends it to a file).
 */
export async function readPhase({ items, conditions, reader, maxTokens, done = new Set(), beforeItem, onRecord }) {
  for (const item of items) {
    await beforeItem?.(item);
    for (const c of conditions) {
      if (done.has(`${item.id}|${c.name}`)) continue;
      const ranked = await c.retrieve(item);
      const built = buildReaderPrompt(item, ranked, c.mustFit ? Infinity : maxTokens);
      const goldSet = new Set(item.goldSessions);
      const base = { id: item.id, type: item.type, cond: c.name, estTokens: estTokens(built.prompt), sessions: built.used.length, dropped: built.dropped, evidenceIn: built.used.some((s) => goldSet.has(s)) };
      if (c.mustFit && estTokens(built.prompt) > maxTokens) {
        onRecord({ ...base, skipped: "does not fit in the context window" });
        continue;
      }
      const r = await reader(built.prompt);
      onRecord({ ...base, answer: r.text, tokens: r.tokens ?? base.estTokens });
    }
  }
}

/** Judge pass over answered records. `judge(prompt)` -> text. `done` holds "id|cond" for this judge. */
export async function judgePhase({ records, items, judge, done = new Set(), onVerdict }) {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const r of records) {
    if (r.skipped || done.has(`${r.id}|${r.cond}`)) continue;
    const raw = await judge(buildJudgePrompt(byId.get(r.id), r.answer));
    onVerdict({ id: r.id, cond: r.cond, verdict: parseVerdict(raw), raw: raw.slice(0, 80) });
  }
}

/** Per-condition table: n, correct, accuracy with Wilson 95% CI, mean tokens in, tokens per correct answer, accuracy by evidence-retrieved. */
export function summarize(records, verdicts) {
  const v = new Map(verdicts.map((x) => [`${x.id}|${x.cond}`, x]));
  const conds = [...new Set(records.map((r) => r.cond))];
  return conds.map((cond) => {
    const rs = records.filter((r) => r.cond === cond);
    const ans = rs.filter((r) => !r.skipped && v.has(`${r.id}|${cond}`));
    const ok = (r) => v.get(`${r.id}|${cond}`).verdict === true;
    const correct = ans.filter(ok).length;
    const tokens = ans.reduce((a, r) => a + r.tokens, 0);
    const split = (flag) => {
      const g = ans.filter((r) => r.evidenceIn === flag);
      return { n: g.length, correct: g.filter(ok).length };
    };
    const [lo, hi] = wilson(correct, ans.length);
    return {
      cond, n: ans.length, skipped: rs.length - ans.length, correct, acc: ans.length ? correct / ans.length : 0, lo, hi,
      unparsed: ans.filter((r) => v.get(`${r.id}|${cond}`).verdict === null).length,
      meanTokens: ans.length ? tokens / ans.length : 0, tokensPerCorrect: correct ? tokens / correct : null,
      evidenceIn: split(true), evidenceMissing: split(false),
    };
  });
}

/** Paired comparison of two conditions on the questions both answered: discordant counts and exact sign-test p. */
export function paired(records, verdicts, a, b) {
  const v = new Map(verdicts.map((x) => [`${x.id}|${x.cond}`, x.verdict === true]));
  const ids = [...new Set(records.filter((r) => r.cond === a && !r.skipped).map((r) => r.id))].filter((id) => v.has(`${id}|${a}`) && v.has(`${id}|${b}`));
  let onlyA = 0;
  let onlyB = 0;
  for (const id of ids) {
    const x = v.get(`${id}|${a}`);
    const y = v.get(`${id}|${b}`);
    if (x && !y) onlyA++;
    if (y && !x) onlyB++;
  }
  return { a, b, n: ids.length, onlyA, onlyB, p: signTestP(onlyA, onlyB) };
}

/** Agreement of two verdict lists (e.g. two judge models, or a judge vs hand labels) on shared keys. */
export function agreement(x, y) {
  const m = new Map(y.map((r) => [`${r.id}|${r.cond}`, r.verdict]));
  const both = x.filter((r) => m.has(`${r.id}|${r.cond}`));
  const same = both.filter((r) => m.get(`${r.id}|${r.cond}`) === r.verdict).length;
  return { n: both.length, same, rate: both.length ? same / both.length : 0 };
}

const pct = (x) => (100 * x).toFixed(1);
export function renderTable(rows) {
  const head = "| Condition | n | correct | accuracy (Wilson 95% CI) | mean tokens in | tokens per correct | acc. if evidence in context | acc. if not |\n|---|---|---|---|---|---|---|---|";
  const frac = (g) => (g.n ? `${pct(g.correct / g.n)}% (${g.correct}/${g.n})` : "-");
  const lines = rows.map((r) => `| ${r.cond}${r.skipped ? ` (${r.skipped} skipped: too long)` : ""} | ${r.n} | ${r.correct} | ${pct(r.acc)}% (${pct(r.lo)} to ${pct(r.hi)}) | ${Math.round(r.meanTokens)} | ${r.tokensPerCorrect ? Math.round(r.tokensPerCorrect) : "-"} | ${frac(r.evidenceIn)} | ${frac(r.evidenceMissing)} |`);
  return [head, ...lines].join("\n");
}
