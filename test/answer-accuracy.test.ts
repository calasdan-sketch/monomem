// bench/answer-accuracy*.mjs: the pipeline runs with a fake reader and judge, so CI needs no model.
import { test } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib: any = await import(new URL("../../bench/answer-accuracy-lib.mjs", import.meta.url).href);

const sessions = [
  { id: "s1", date: "2023/01/01", text: "user: my dog is called Rex" },
  { id: "s2", date: "2023/02/01", text: "user: I moved to Lisbon last week" },
  { id: "s3", date: "2023/03/01", text: "user: pasta recipes are lovely" },
];
const items = [
  { id: "q1", type: "single-session-user", question: "What is my dog called?", answer: "Rex", qdate: "2023/04/01", haystack: "h", sessions, goldSessions: ["s1"] },
  { id: "q2", type: "temporal-reasoning", question: "Where did I move to?", answer: "Lisbon", qdate: "", haystack: "h", sessions, goldSessions: ["s2"] },
];

test("wilson interval matches known values and stays inside 0..1", () => {
  const [lo, hi] = lib.wilson(50, 100);
  assert.ok(Math.abs(lo - 0.4038) < 0.001 && Math.abs(hi - 0.5962) < 0.001);
  assert.deepEqual(lib.wilson(0, 0), [0, 0]);
  const [l0, h0] = lib.wilson(0, 10);
  assert.equal(l0, 0);
  assert.ok(h0 > 0.2 && h0 < 0.35);
});

test("sign test: 8 vs 0 discordant is p=0.0078, 5 vs 5 is p=1", () => {
  assert.ok(Math.abs(lib.signTestP(8, 0) - 0.0078125) < 1e-9);
  assert.equal(lib.signTestP(5, 5), 1);
  assert.equal(lib.signTestP(0, 0), 1);
});

test("sampling is deterministic for a seed and differs across seeds", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `q${i}` }));
  const a = lib.sampleItems(many, "s", 10).map((x: { id: string }) => x.id);
  assert.deepEqual(a, lib.sampleItems([...many].reverse(), "s", 10).map((x: { id: string }) => x.id));
  assert.notDeepEqual(a, lib.sampleItems(many, "t", 10).map((x: { id: string }) => x.id));
});

test("bm25 ranks the session holding the query words first", () => {
  assert.equal(lib.bm25Rank(sessions, "what is my dog called Rex", 3)[0], "s1");
  assert.equal(lib.bm25Rank(sessions, "Lisbon", 1)[0], "s2");
});

test("reader prompt drops the lowest-ranked sessions until it fits", () => {
  const big = [0, 1, 2].map((i) => ({ id: `b${i}`, date: `2023/0${i + 1}/01`, text: "x".repeat(4000) }));
  const r = lib.buildReaderPrompt(items[0], big, 1500);
  assert.equal(r.used.length, 1);
  assert.equal(r.used[0], "b0");
  assert.equal(r.dropped, 2);
});

test("judge verdict parsing treats anything but yes/no as unparsed", () => {
  assert.equal(lib.parseVerdict("Yes."), true);
  assert.equal(lib.parseVerdict("  no, because"), false);
  assert.equal(lib.parseVerdict("maybe"), null);
  assert.match(lib.buildJudgePrompt(items[1], "Lisbon"), /off-by-one/);
});

test("LongMemEval and LoCoMo normalizers skip abstention and unanswerable questions", () => {
  const lme = lib.normalizeLongMemEval([
    { question_id: "a", question_type: "t", question: "q", answer: "x", answer_session_ids: ["s"], haystack_sessions: [[{ role: "user", content: "hi" }]], haystack_session_ids: ["s"], haystack_dates: ["d"] },
    { question_id: "b_abs", question: "q", answer: "x", answer_session_ids: ["s"] },
  ]);
  assert.equal(lme.length, 1);
  assert.equal(lme[0].sessions[0].text, "user: hi");
  const loc = lib.normalizeLoCoMo([
    { sample_id: "c", conversation: { session_1: [{ speaker: "A", text: "hello" }], session_1_date_time: "1:56 pm on 8 May, 2023" }, qa: [{ question: "q", answer: 7, category: 1, evidence: ["D1:1"] }, { question: "adv", category: 5, evidence: ["D1:1"] }] },
  ]);
  assert.equal(loc.length, 1);
  assert.equal(loc[0].answer, "7");
  assert.deepEqual(loc[0].goldSessions, ["D1"]);
});

test("full pipeline with a fake reader and judge: accuracy, CI, skipped full-history, paired counts", async () => {
  const conditions = [
    { name: "good", retrieve: async () => sessions },
    { name: "empty", retrieve: async () => [sessions[2]] },
    { name: "full", mustFit: true, retrieve: async () => sessions },
  ];
  // Fake reader: answers from the prompt text. Fake judge: yes iff the response contains the gold answer.
  const reader = async (p: string) => ({ text: p.includes("Rex") && p.includes("dog called") ? "Rex" : p.includes("Lisbon") ? "Lisbon" : "I do not know", tokens: p.length });
  const records: unknown[] = [];
  await lib.readPhase({ items, conditions, reader, maxTokens: 30, onRecord: (r: unknown) => records.push(r) });
  // maxTokens 30 is below the prompt size, so "full" (mustFit) is skipped; the others are trimmed to one session.
  const full = records.filter((r) => (r as { cond: string }).cond === "full") as Array<{ skipped?: string }>;
  assert.equal(full.length, 2);
  assert.ok(full.every((r) => r.skipped));

  const roomy: unknown[] = [];
  await lib.readPhase({ items, conditions, reader, maxTokens: 10000, onRecord: (r: unknown) => roomy.push(r) });
  const verdicts: unknown[] = [];
  const byQ = new Map(items.map((i) => [i.question, i.answer]));
  const judge = async (p: string) => {
    const q = /Question: (.*)\n/.exec(p)![1];
    const resp = /Model response: (.*)\n/.exec(p)![1];
    return resp.includes(byQ.get(q)!) ? "yes" : "no";
  };
  await lib.judgePhase({ records: roomy, items, judge, onVerdict: (v: unknown) => verdicts.push(v) });
  const rows = lib.summarize(roomy, verdicts);
  const row = (c: string) => rows.find((r: { cond: string }) => r.cond === c);
  assert.equal(row("good").correct, 2);
  assert.equal(row("empty").correct, 0);
  assert.equal(row("full").correct, 2);
  assert.equal(row("good").tokensPerCorrect, row("good").meanTokens * 2 / 2);
  assert.deepEqual([row("good").evidenceIn.n, row("empty").evidenceMissing.n], [2, 2]);
  const p = lib.paired(roomy, verdicts, "good", "empty");
  assert.deepEqual([p.onlyA, p.onlyB], [2, 0]);
  assert.match(lib.renderTable(rows), /\| good \| 2 \| 2 \| 100\.0%/);
  assert.equal(lib.agreement(verdicts, verdicts).rate, 1);
});

test("a resumed run skips records already on disk", async () => {
  let reads = 0;
  await lib.readPhase({
    items, conditions: [{ name: "good", retrieve: async () => sessions }], maxTokens: 10000,
    done: new Set(["q1|good"]), reader: async () => { reads++; return { text: "x", tokens: 1 }; }, onRecord: () => {},
  });
  assert.equal(reads, 1);
});
