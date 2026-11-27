// Round 3, 05-RT-4: wrong /login codes are rate-limited per source and never spend the real code.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LoginGuard } from "../src/api/login-guard.js";
import { mintLoginCode, redeemLogin } from "../src/login-code.js";

test("a source is blocked after 8 wrong codes in a minute, others are not, and it clears with time", () => {
  let t = 1_000;
  const g = new LoginGuard(() => t);
  for (let i = 0; i < 7; i++) g.fail("a");
  assert.equal(g.blocked("a"), false);
  g.fail("a");
  assert.equal(g.blocked("a"), true);
  assert.equal(g.blocked("b"), false);
  t += 61_000;
  assert.equal(g.blocked("a"), false);
});

test("wrong guesses leave the real code usable; the right code works once; an expired code is spent", () => {
  const code = mintLoginCode(5_000);
  for (let i = 0; i < 20; i++) assert.equal(redeemLogin("0".repeat(31) + String(i % 10), 6_000), null);
  assert.deepEqual(redeemLogin(code, 6_000) !== null, true);
  assert.equal(redeemLogin(code, 6_000), null, "single use");
  const old = mintLoginCode(1_000);
  assert.equal(redeemLogin(old, 1_000 + 61_000), null);
  assert.equal(redeemLogin(old, 1_500), null, "expired code was removed");
});

