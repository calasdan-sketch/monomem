// Metric functions and dataset parsing of `monomem bench --longmemeval / --locomo`, on tiny inline fixtures (no download).
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, dedupe, ndcg, percentile, reciprocalRank, recallAll, recallAny, scoreQuestion } from "../src/bench/retrieval-metrics.js";
import { lmeDate, locomoDate, locomoHaystacks, longMemEvalHaystacks } from "../src/bench/retrieval.js";

const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("recall, nDCG and MRR on a hand-checked ranking", () => {
  const ranked = ["a", "g1", "b", "c", "d", "e", "f", "h", "i", "j", "g2"];
  const gold = new Set(["g1", "g2"]);
  assert.equal(recallAny(ranked, gold, 1), 0);
  assert.equal(recallAny(ranked, gold, 5), 1);
  assert.equal(recallAll(ranked, gold, 10), 0); // g2 is 11th
  assert.equal(recallAll(ranked, gold, 11), 1);
  close(reciprocalRank(ranked, gold), 0.5);
  // DCG = 1/log2(3); IDCG = 1 + 1/log2(3)
  close(ndcg(ranked, gold, 10), 1 / Math.log2(3) / (1 + 1 / Math.log2(3)));
  close(ndcg(["g1", "g2"], gold, 10), 1);
  assert.deepEqual(scoreQuestion([], gold), { r5: 0, rAll5: 0, r10: 0, rAll10: 0, ndcg10: 0, mrr: 0 });
});

test("Rall@5 (C-03): every gold id must be in the top 5, any-hit R@5 is not enough", () => {
  const gold = new Set(["g1", "g2"]);
  const split = scoreQuestion(["g1", "a", "b", "c", "d", "g2"], gold); // g2 is 6th
  assert.equal(split.r5, 1);
  assert.equal(split.rAll5, 0);
  assert.equal(scoreQuestion(["a", "g2", "b", "g1"], gold).rAll5, 1);
  const m = aggregate([{ type: "A", score: split }, { type: "A", score: scoreQuestion(["g1", "g2"], gold) }]);
  assert.equal(m.all.rAll5, 0.5);
});

test("dedupe keeps first occurrence; percentile is nearest-rank", () => {
  assert.deepEqual(dedupe(["s1", "s2", "s1", "s3"]), ["s1", "s2", "s3"]);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([], 50), 0);
});

test("aggregate averages overall and per type", () => {
  const one = scoreQuestion(["x"], new Set(["x"]));
  const zero = scoreQuestion(["y"], new Set(["x"]));
  const m = aggregate([{ type: "A", score: one }, { type: "A", score: zero }, { type: "B", score: one }]);
  assert.equal(m.all.n, 3);
  close(m.all.r5, 2 / 3);
  assert.equal(m.A.r10, 0.5);
  assert.equal(m.B.mrr, 1);
});

test("LongMemEval parsing: sessions, turns mapped to sessions, _abs skipped, dates", () => {
  const data = [
    {
      question_id: "q1",
      question_type: "single-session-user",
      question: "What degree?",
      answer_session_ids: ["s2"],
      haystack_session_ids: ["s1", "s2"],
      haystack_dates: ["2023/05/20 (Sat) 02:21", "2023/05/21 (Sun) 10:00"],
      haystack_sessions: [[{ role: "user", content: "hi" }], [{ role: "user", content: "I got a BA" }, { role: "assistant", content: "nice" }]],
    },
    { question_id: "q2_abs", question: "x", answer_session_ids: ["s1"], haystack_sessions: [] },
    "garbage",
  ];
  const s = longMemEvalHaystacks(data, "session");
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].docs.map((d) => d.unit), ["s1", "s2"]);
  assert.equal(s[0].docs[1].body, "user: I got a BA\nassistant: nice");
  assert.equal(s[0].docs[0].date, "2023-05-20T02:21:00.000Z");
  const t = longMemEvalHaystacks(data, "turn");
  assert.deepEqual(t[0].docs.map((d) => d.unit), ["s1", "s2", "s2"]);
  assert.equal(lmeDate("nonsense"), undefined);
});

test("LoCoMo parsing: evidence split, session mapping, dates", () => {
  const data = [
    {
      sample_id: "c1",
      conversation: {
        speaker_a: "A",
        session_1: [{ speaker: "A", dia_id: "D1:1", text: "hello" }, { speaker: "B", dia_id: "D1:2", text: "pic", blip_caption: "a dog" }],
        session_1_date_time: "1:56 pm on 8 May, 2023",
        session_2: [{ speaker: "A", dia_id: "D2:1", text: "bye" }],
      },
      qa: [
        { question: "q?", evidence: ["D1:2; D2:1"], category: 2 },
        { question: "none?", evidence: [], category: 5 },
      ],
    },
  ];
  const t = locomoHaystacks(data, "turn");
  assert.equal(t[0].docs.length, 3);
  assert.equal(t[0].docs[1].body, "B: pic [shares image: a dog]");
  assert.equal(t[0].questions.length, 1);
  assert.deepEqual([...t[0].questions[0].gold], ["D1:2", "D2:1"]);
  assert.equal(t[0].questions[0].type, "category 2");
  const s = locomoHaystacks(data, "session");
  assert.deepEqual(s[0].docs.map((d) => d.unit), ["D1", "D2"]);
  assert.deepEqual([...s[0].questions[0].gold], ["D1", "D2"]);
  assert.equal(locomoDate("1:56 pm on 8 May, 2023"), "2023-05-08T13:56:00.000Z");
  assert.equal(locomoDate("12:05 am on 1 June, 2023"), "2023-06-01T00:05:00.000Z");
});

test("encrypted retrieval run (C-06): same corpus with a key file; body-only answers are lost (titles are session ids)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runRetrieval } = await import("../src/bench/retrieval.js");
  const file = join(mkdtempSync(join(tmpdir(), "monomem-c06-")), "lme.json");
  const sessions = Array.from({ length: 6 }, (_, i) => [{ role: "user", content: i === 3 ? "my giraffe is named Zuzu" : `filler talk ${i}` }]);
  writeFileSync(file, JSON.stringify([{
    question_id: "q1", question_type: "single-session-user", question: "What is my giraffe named?", answer_session_ids: ["s3"],
    haystack_session_ids: sessions.map((_, i) => `s${i}`), haystack_dates: [], haystack_sessions: sessions,
  }]));
  const plain = await runRetrieval({ dataset: "longmemeval", data: file, mode: "keyword", granularity: "session" });
  const enc = await runRetrieval({ dataset: "longmemeval", data: file, mode: "keyword", granularity: "session", encrypted: true });
  assert.equal(plain.encrypted, false);
  assert.equal(enc.encrypted, true);
  assert.equal(plain.keyword.metrics.all.r5, 1);
  // Measured gap, not a goal: keyword search covers title + tags only while encryption is on (SECURITY.md). If bodies become
  // searchable when encrypted, flip this to 1.
  assert.equal(enc.keyword.metrics.all.r5, 0);
});
