// Identifier-aware keyword search (src/query-expand.ts): "get user by id" finds getUserById, and so on.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { expandIdentifiers, identifierParts } from "../src/query-expand.js";

const corpus = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "evals", "identifier-queries.json"), "utf8")) as {
  notes: Array<{ title: string; body: string }>;
  queries: Array<{ q: string; finds?: string; not?: string[] }>;
};

describe("identifier parts", () => {
  test("camel, pascal, acronym, snake, kebab, dotted and path words split into lower-case parts", () => {
    assert.deepEqual(identifierParts("getUserById"), ["get", "user", "by", "id"]);
    assert.deepEqual(identifierParts("HttpServerConfig"), ["http", "server", "config"]);
    assert.deepEqual(identifierParts("HTTPServer"), ["http", "server"]);
    assert.deepEqual(identifierParts("user_session_timeout"), ["user", "session", "timeout"]);
    assert.deepEqual(identifierParts("retry-on-failure"), ["retry", "on", "failure"]);
    assert.deepEqual(identifierParts("src/auth/session.ts"), ["src", "auth", "session", "ts"]);
    assert.deepEqual(identifierParts("plain"), ["plain"]);
  });
  test("a query with no identifier words is unchanged", () => {
    assert.equal(expandIdentifiers(["hello"], ['"hello"*']), '"hello"*');
    assert.equal(expandIdentifiers(["a", "b", "c", "d", "e", "f", "g"], ["x1", "x2", "x3", "x4", "x5", "x6", "x7"].map((s) => `"${s}"*`)), '"x1"* AND "x2"* AND "x3"* AND "x4"* AND "x5"* AND "x6"* AND "x7"*');
  });
  test("a huge or unusual word is bounded", () => {
    const long = "aB".repeat(200);
    assert.equal(expandIdentifiers([long], [`"${long}"*`]), `"${long}"*`);
    const many = Array.from({ length: 20 }, (_, i) => `w${i}Part`);
    const out = expandIdentifiers(many, many.map((w) => `"${w}"*`));
    assert.ok(out.length < 6000, `bounded, got ${out.length}`);
  });
});

describe("keyword search over code identifiers (evals/identifier-queries.json)", () => {
  const store = new Store(":memory:");
  for (const n of corpus.notes) store.create({ title: n.title, body: n.body, tags: [] });
  const titles = (q: string): string[] => store.search(q, { limit: 20 }).map((n) => n.title);

  for (const c of corpus.queries) {
    test(`"${c.q}"`, () => {
      const got = titles(c.q);
      if (c.finds) assert.ok(got.includes(c.finds), `expected ${c.finds}, got [${got.join(", ")}]`);
      for (const bad of c.not ?? []) assert.ok(!got.includes(bad), `${bad} must not be returned for "${c.q}": [${got.join(", ")}]`);
    });
  }

  test("a query that matches nothing and a punctuation-only query still behave", () => {
    assert.deepEqual(titles("nonexistentidentifier"), []);
    assert.deepEqual(titles("___ ---"), []);
  });
  test("no FTS syntax error from odd identifier-like input", () => {
    for (const q of ['say"Hi', "a_b_c_d_e_f_g_h_i_j", "foo.bar.baz()", "C:\\path\\to\\File.ts", "(getUser)", "x OR y", "NEAR(a b)"]) assert.doesNotThrow(() => titles(q), q);
  });
});
