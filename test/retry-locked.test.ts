// r6: opening the store while another process holds the lock (cold start of several servers at once) is retried, not fatal.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryWhileLocked } from "../src/retry-locked.js";

test("retries a locked error and returns the later success", () => {
  let n = 0;
  const v = retryWhileLocked(() => { if (++n < 3) throw new Error("database is locked"); return "ok"; }, 5, 1);
  assert.equal(v, "ok");
  assert.equal(n, 3);
});
test("gives up after the last try with the original error", () => {
  let n = 0;
  assert.throws(() => retryWhileLocked(() => { n++; throw new Error("database is busy"); }, 3, 1), /busy/);
  assert.equal(n, 3);
});
test("any other error is thrown at once", () => {
  let n = 0;
  assert.throws(() => retryWhileLocked(() => { n++; throw new Error("disk I/O error"); }, 5, 1), /disk/);
  assert.equal(n, 1);
});
