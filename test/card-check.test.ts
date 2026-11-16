// The card-number check (pii.ts): ordinary decimals, versions and prices are not card numbers. 1.5.0 flagged 200 of 3,075
// real notes on floats like 0.7730349485110593 (any 13-19 digit run that passed Luhn), which cost the store a health grade.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findPii, scanPii } from "../src/pii.js";
import { Store } from "../src/store.js";
import { qualityReport } from "../src/quality.js";

const cards = (s: string): number => findPii(s).filter((h) => h.kind === "card").length;

/** A fixed pseudo-random corpus of floats shaped like Math.random() output and benchmark scores (13-17 digits after the point). */
function floats(n: number): string[] {
  let x = 123456789;
  const digit = (): number => Math.floor((x = (x * 1103515245 + 12345) % 2147483648) / 214748365);
  const run = (k: number): string => Array.from({ length: k }, digit).join("");
  return Array.from({ length: n }, (_, i) => `${i % 3 === 0 ? "0" : String(1 + digit())}.${run(13 + (i % 5))}`);
}

describe("card check: no false alarms on numbers that are not cards", () => {
  test("decimals, versions, prices and scores are not card numbers", () => {
    for (const s of [
      "pi is 3.14159265358979",
      "score 0.7730349485110593",
      "ratio=0.4532118839920176 after tuning",
      "release v1.2.3.4",
      "it costs $1,234.56 or 4999.99 a year",
      "build 20261116.1234567890123",
      "timestamp 1731772800000123",
      "uuid-ish 4111111111111111-ab",
      "x=-4111111111111111",
    ]) assert.equal(cards(s), 0, s);
  });

  test("1,000 random floats give no card hits", () => {
    const hits = floats(1000).filter((f) => cards(`value ${f} measured`) > 0);
    assert.deepEqual(hits, []);
  });

  test("real card shapes still hit: grouped numbers, and a run of digits that a card word introduces", () => {
    assert.equal(cards("card 4111 1111 1111 1111"), 1);
    assert.equal(cards("mastercard 5500-0000-0000-0004"), 1);
    assert.equal(cards("amex 3782 822463 10005"), 1);
    assert.equal(cards("my visa is 4111111111111111"), 1);
    assert.equal(cards("credit card number: 5555555555554444"), 1);
    assert.equal(cards("card 4111 1111 1111 1112"), 0, "fails Luhn");
    assert.equal(cards("card 9111 1111 1111 1111"), 0, "no card starts with 9");
    assert.equal(cards("order id 4111111111111111"), 0, "a bare digit run with no card word is an id, not a card");
  });

  test("a store full of benchmark floats keeps its personal-data count at 0", async () => {
    const s = new Store(":memory:");
    for (const [i, f] of floats(60).entries()) s.create({ title: `run ${i}`, body: `recall@5 ${f}, precision 0.${f.replace(/\D/g, "")}` });
    assert.equal(scanPii(s.exportAll({ live: true })).suggestions.length, 0);
    assert.equal((await qualityReport(s)).counts.pii, 0);
    s.close();
  });
});
