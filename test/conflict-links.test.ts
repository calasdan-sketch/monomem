// Save-time conflict links (report 03 C1b/C1c): detector, recorded link, search reorder, guards, save reply. Nothing is ever deleted.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { flagConflict, findConflictCandidates } from "../src/conflict-detect.js";
import { conflictsField } from "../src/store/conflict-links.js";
import { runSearch } from "../src/search-service.js";
import { actorStore } from "../src/actor.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const iso = (d: number): string => new Date(Date.now() - d * 864e5).toISOString();
const put = (s: Store, w: string, title: string, body: string, ageDays: number, extra: object = {}) =>
  as(w, () => s.create({ title, body, created_at: iso(ageDays), ...extra }, { skipEdges: true, lint: "none", updatedAt: iso(ageDays) }));

describe("flagConflict", () => {
  test("a negation added on the same subject is flagged", () => {
    const f = flagConflict({ title: "Dark mode", body: "dark mode is enabled for all users" }, { title: "Dark mode", body: "dark mode is NOT enabled for any users" });
    assert.equal(f?.kind, "negation");
  });
  test("'migrated to' with a new target is a switch, even with no shared word but a synonym", () => {
    const f = flagConflict({ title: "Database choice", body: "Our primary database is PostgreSQL." }, { title: "Switched", body: "Migrated the main datastore to MySQL last sprint." });
    assert.equal(f?.kind, "switch");
  });
  test("a changed region code is a value flip", () => {
    assert.equal(flagConflict({ title: "Deploy region", body: "We deploy production to us-east-1." }, { title: "Deploy region", body: "We deploy production to eu-west-1." })?.kind, "value");
  });
  test("two notes on the same subject with no flip are not flagged", () => {
    assert.equal(flagConflict({ title: "Deploy region", body: "We deploy production to us-east-1." }, { title: "Deploy region", body: "Production deploys to us-east-1 happen on Tuesdays." }), null);
  });
  test("unrelated notes are not flagged", () => {
    assert.equal(flagConflict({ title: "Lunch", body: "Lunch is at noon." }, { title: "Rota", body: "Not on call this week." }), null);
  });
});

describe("links and search", () => {
  test("C1b: a newer note that shares no query word is brought in above the older one", async () => {
    const s = new Store(":memory:");
    const o = put(s, "a", "Database choice", "Our primary database is PostgreSQL. The database choice was PostgreSQL after evaluating database options.", 30);
    const n = put(s, "b", "Switched storage", "Migrated the main datastore to MySQL last sprint.", 1);
    const ids = (await runSearch(s, "what database do we use", { mode: "keyword", limit: 5 })).map((x) => x.id);
    assert.deepEqual(ids.slice(0, 2), [n.id, o.id]);
  });
  test("C1c: the older note is demoted below the newer one that negates it, and both stay", async () => {
    const s = new Store(":memory:");
    const o = put(s, "a", "Feature flag dark mode", "dark mode is enabled for all users", 20);
    const n = put(s, "b", "Feature flag dark mode", "dark mode is NOT enabled for any users, rolled back", 2);
    const ids = (await runSearch(s, "is dark mode enabled", { mode: "keyword", limit: 5 })).map((x) => x.id);
    assert.deepEqual(ids, [n.id, o.id]);
    assert.ok(s.read(o.id), "older note is untouched");
  });
  test("the save reply field names the contradicted note and says nothing was changed", () => {
    const s = new Store(":memory:");
    const o = put(s, "a", "Feature flag dark mode", "dark mode is enabled for all users", 20);
    const n = put(s, "b", "Feature flag dark mode", "dark mode is NOT enabled for any users", 2);
    const f = conflictsField(s, n.id).conflicts_with ?? [];
    assert.equal(f[0]?.id, o.id);
    assert.match(f[0].hint, /nothing was changed/);
  });
  test("a person-confirmed older note is not demoted by an unconfirmed newer one", async () => {
    const s = new Store(":memory:");
    const o = put(s, "a", "Feature flag dark mode", "dark mode is enabled for all users", 20);
    const n = put(s, "b", "Feature flag dark mode", "dark mode is NOT enabled for any users", 2, { outside: true });
    const ids = (await runSearch(s, "is dark mode enabled", { mode: "keyword", limit: 5 })).map((x) => x.id);
    assert.ok(ids.indexOf(o.id) <= ids.indexOf(n.id) || ids.indexOf(n.id) === -1, "an unconfirmed outside note never outranks through a link");
  });
  test("a time-filtered search never gets a linked note added past its filter", async () => {
    const s = new Store(":memory:");
    const o = put(s, "a", "Database choice", "Our primary database is PostgreSQL for all database work.", 30);
    put(s, "b", "Switched storage", "Migrated the main datastore to MySQL last sprint.", 1);
    const r = await runSearch(s, "database", { mode: "keyword", limit: 5, timeRange: { start: new Date(Date.now() - 40 * 864e5), end: new Date(Date.now() - 20 * 864e5) } });
    assert.deepEqual(r.map((x) => x.id), [o.id]);
  });
  test("MONOMEM_CONFLICT_LINKS=0 records nothing", () => {
    process.env.MONOMEM_CONFLICT_LINKS = "0";
    try {
      const s = new Store(":memory:");
      put(s, "a", "Feature flag dark mode", "dark mode is enabled for all users", 20);
      const n = put(s, "b", "Feature flag dark mode", "dark mode is NOT enabled for any users", 2);
      assert.deepEqual(conflictsField(s, n.id), {});
    } finally {
      delete process.env.MONOMEM_CONFLICT_LINKS;
    }
  });
  test("candidates stay inside the namespace", () => {
    const s = new Store(":memory:");
    put(s, "a", "Feature flag dark mode", "dark mode is enabled for all users", 20, { namespace: "other" });
    const n = put(s, "b", "Feature flag dark mode", "dark mode is NOT enabled for any users", 2);
    assert.deepEqual(findConflictCandidates(s, n), []);
  });
});
