// recall@k reporting: k = 1, 3, 5, 10, 20 for every mode, skipped modes named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, scoreQuestion } from "../src/bench/retrieval-metrics.js";
import { renderRecallAtK } from "../src/bench/retrieval-table.js";

const gold = new Set(["g"]);
const at = (pos: number) => aggregate([{ type: "A", score: scoreQuestion([...Array(pos - 1).fill("x"), "g"], gold) }]);

test("scoreQuestion reports recall at 1, 3, 5, 10, 20", () => {
  const s = scoreQuestion([...Array(6).fill("x"), "g"], gold); // gold is 7th
  assert.deepEqual([s.r1, s.r3, s.r5, s.r10, s.r20], [0, 0, 0, 1, 1]);
  const t = scoreQuestion([...Array(20).fill("x"), "g"], gold); // 21st
  assert.equal(t.r20, 0);
});

test("renderRecallAtK shows every mode, including one worse than keyword, and names skipped ones", () => {
  const out = renderRecallAtK({ keyword: { metrics: at(1) }, relevant: { metrics: at(1) }, semantic: { metrics: at(4) }, hybrid: { skipped: "embeddings are off" } });
  const rows = out.split("\n");
  assert.match(rows[1], /R@1\s+R@3\s+R@5\s+R@10\s+R@20/);
  assert.match(rows.find((r) => r.startsWith("keyword"))!, /100\.0\s+100\.0\s+100\.0\s+100\.0\s+100\.0/);
  assert.match(rows.find((r) => r.startsWith("semantic"))!, /0\.0\s+0\.0\s+100\.0\s+100\.0\s+100\.0/);
  assert.match(out, /hybrid\s+skipped: embeddings are off/);
});
