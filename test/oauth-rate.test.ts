// OAuth rate limiting behind a tunnel on the same machine: one caller must not be able to lock out everyone.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { RateLimiter } from "../src/security.js";
import { oauthAllow, oauthClientKey } from "../src/oauth/rate.js";

const req = (remote: string, headers: Record<string, string> = {}): IncomingMessage => ({ headers, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;
const SAVED = { p: process.env.MONOMEM_TRUST_PROXY, c: process.env.MONOMEM_TRUST_CLOUDFLARE };
afterEach(() => {
  for (const [k, v] of [["MONOMEM_TRUST_PROXY", SAVED.p], ["MONOMEM_TRUST_CLOUDFLARE", SAVED.c]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("behind a tunnel on this machine, no proxy declared", () => {
  test("callers that name different addresses get separate buckets; the flood of one does not refuse the other", () => {
    delete process.env.MONOMEM_TRUST_PROXY;
    delete process.env.MONOMEM_TRUST_CLOUDFLARE;
    const per = new RateLimiter(3, 60_000);
    const global = new RateLimiter(100, 60_000);
    const flooder = req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" });
    const honest = req("127.0.0.1", { "x-forwarded-for": "198.51.100.4" });
    const results = Array.from({ length: 10 }, () => oauthAllow(per, global, flooder));
    assert.equal(results.filter(Boolean).length, 3, "the flooder is held to its own limit");
    assert.equal(oauthAllow(per, global, honest), true, "an honest caller is still served");
  });
  test("the key says it is a claim, not an address", () => {
    delete process.env.MONOMEM_TRUST_PROXY;
    assert.match(oauthClientKey(req("::1", { "x-forwarded-for": "1.2.3.4, 5.6.7.8" })), /^tunnel:1\.2\.3\.4$/);
    assert.equal(oauthClientKey(req("::ffff:127.0.0.1")), "tunnel:none");
  });
  test("the global cap counts only requests that passed their own bucket, and still bounds a flood of changing headers", () => {
    delete process.env.MONOMEM_TRUST_PROXY;
    const per = new RateLimiter(2, 60_000);
    const global = new RateLimiter(5, 60_000);
    let allowed = 0;
    for (let i = 0; i < 40; i++) if (oauthAllow(per, global, req("127.0.0.1", { "x-forwarded-for": `10.0.0.${i}` }))) allowed++;
    assert.equal(allowed, 5, "a caller who changes the header every time is stopped by the global cap");
    const per2 = new RateLimiter(2, 60_000);
    const global2 = new RateLimiter(5, 60_000);
    const one = req("127.0.0.1", { "x-forwarded-for": "10.9.9.9" });
    for (let i = 0; i < 50; i++) oauthAllow(per2, global2, one); // one caller refused again and again
    assert.equal(oauthAllow(per2, global2, req("127.0.0.1", { "x-forwarded-for": "10.8.8.8" })), true, "its refusals did not use up the global cap");
  });
});

describe("a proxy is declared", () => {
  test("the rightmost forwarded address is the key, so each caller has their own bucket", () => {
    process.env.MONOMEM_TRUST_PROXY = "1";
    assert.equal(oauthClientKey(req("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 203.0.113.9" })), "203.0.113.9");
    const per = new RateLimiter(2, 60_000);
    const global = new RateLimiter(100, 60_000);
    const a = req("127.0.0.1", { "x-forwarded-for": "203.0.113.9" });
    const b = req("127.0.0.1", { "x-forwarded-for": "198.51.100.4" });
    assert.deepEqual([oauthAllow(per, global, a), oauthAllow(per, global, a), oauthAllow(per, global, a)], [true, true, false]);
    assert.equal(oauthAllow(per, global, b), true);
  });
});

describe("a direct caller (not this machine)", () => {
  test("is keyed on its socket address, and an x-forwarded-for header it sends is ignored", () => {
    delete process.env.MONOMEM_TRUST_PROXY;
    delete process.env.MONOMEM_TRUST_CLOUDFLARE;
    assert.equal(oauthClientKey(req("203.0.113.50", { "x-forwarded-for": "1.1.1.1" })), "203.0.113.50");
  });
});
