// Regression suite of the model-free ranking hard cases from report 03 (cases.mjs): contradictions, time phrases, synonyms,
// CJK, floods. Keyword mode only (the default, no embeddings). Each case is tiny and synthetic: a probe, not a statistic.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { runSearch } from "../src/search-service.js";
import { dampenNearDuplicates } from "../src/search-diversity.js";
import { synonymsOf, canon } from "../src/search-synonyms.js";

const iso = (d: number): string => new Date(Date.now() - d * 864e5).toISOString();
const as = <T>(w: string, fn: () => T): T => actorStore.run({ label: w, authed: true }, fn);
const add = (s: Store, w: string, title: string, body: string, ageDays = 0) =>
  as(w, () => s.create({ title, body, created_at: iso(ageDays) }, { skipEdges: true, lint: "none", updatedAt: iso(ageDays) }));
const ranks = async (s: Store, q: string, limit = 10): Promise<number[]> => (await runSearch(s, q, { mode: "keyword", limit })).map((n) => n.id);

describe("contradictions", () => {
  test("C1a same title, opposite value: newer first", async () => {
    const s = new Store(":memory:");
    add(s, "A", "Deploy region", "We deploy production to us-east-1.", 10);
    const b = add(s, "B", "Deploy region", "We deploy production to eu-west-1.", 1);
    assert.equal((await ranks(s, "which region do we deploy production to"))[0], b.id);
  });
  test("C1b newer note in different words (switch cue + synonym): newer first", async () => {
    const s = new Store(":memory:");
    add(s, "A", "Database choice", "Our primary database is PostgreSQL. The database choice for the primary database was PostgreSQL after evaluating database options.", 30);
    const n = add(s, "B", "Switched storage", "Migrated the main datastore to MySQL last sprint.", 1);
    assert.equal((await ranks(s, "what database do we use"))[0], n.id);
  });
  test("C1c negation: newer first", async () => {
    const s = new Store(":memory:");
    add(s, "A", "Feature flag dark mode", "dark mode is enabled for all users", 20);
    const y = add(s, "B", "Feature flag dark mode", "dark mode is NOT enabled for any users, rolled back", 2);
    assert.equal((await ranks(s, "is dark mode enabled"))[0], y.id);
  });
  test("C1d three versions: newest first", async () => {
    const s = new Store(":memory:");
    const v = ["alpha", "bravo", "charlie"].map((x, i) => add(s, "agent" + i, "Release codename", `The release codename is ${x}.`, 30 - i * 14));
    assert.equal((await ranks(s, "release codename"))[0], v[2].id);
  });
  test("C1e terse newer vs verbose older: newer first", async () => {
    const s = new Store(":memory:");
    add(s, "a", "API rate limit", "API rate limit is 100 requests per minute per key. The rate limit applies to every API key. API rate limit headers are returned.", 25);
    const n = add(s, "b", "API rate limit", "API rate limit raised to 500 requests per minute.", 1);
    assert.equal((await ranks(s, "API rate limit requests per minute"))[0], n.id);
  });
});

describe("time phrases", () => {
  const world = () => {
    const s = new Store(":memory:");
    const days = [1, 3, 8, 15, 40, 100];
    const ns = days.map((d) => add(s, "w", "Standup notes", `Standup summary for the team: worked on billing item ${d}.`, d));
    return { s, ns };
  };
  test("T1 'last week': in-window notes (3d, 8d) beat the newer note just outside it (1d)", async () => {
    const { s, ns } = world();
    const r = await ranks(s, "what happened last week standup");
    assert.ok(r.indexOf(ns[2].id) < r.indexOf(ns[0].id), "8d before 1d");
    assert.ok(r.indexOf(ns[1].id) < r.indexOf(ns[0].id), "3d before 1d");
  });
  test("T2 'yesterday': newest first", async () => {
    const { s, ns } = world();
    assert.equal((await ranks(s, "standup yesterday"))[0], ns[0].id);
  });
  test("T3 'three months ago': the 100-day note first", async () => {
    const { s, ns } = world();
    assert.equal((await ranks(s, "standup three months ago"))[0], ns[5].id);
  });
});

describe("synonyms and irregular verbs", () => {
  test("P1 zero-shared-word queries find the note (car/automobile, doctor/physician, fired/terminated, buy/purchase)", async () => {
    const s = new Store(":memory:");
    const cases: Array<[string, string, string]> = [
      ["note automobile", "The company automobile must be returned to the garage by Friday.", "where should I park my car"],
      ["note physician", "Book a physician appointment for the annual checkup.", "schedule a doctor visit"],
      ["note terminated", "The contractor was terminated for missing deadlines.", "who got fired"],
      ["note purchase", "Purchase order approved for twenty laptops.", "we want to buy laptops"],
    ];
    const ids = cases.map(([t, b]) => add(s, "x", t, b).id);
    for (let i = 0; i < 30; i++) add(s, "x", "filler " + i, `Quarterly planning item ${i} covers budget, hiring and roadmap tradeoffs.`);
    for (const [i, c] of cases.entries()) assert.ok((await ranks(s, c[2], 5)).includes(ids[i]), c[2]);
  });
  test("an irregular form reaches its base form (bought finds 'buy')", async () => {
    const s = new Store(":memory:");
    const n = add(s, "x", "Laptop order", "We will buy new laptops next quarter.");
    for (let i = 0; i < 10; i++) add(s, "x", "filler " + i, `Planning item ${i} covers budget and roadmap.`);
    assert.ok((await ranks(s, "who bought the laptops", 5)).includes(n.id));
  });
  test("the table folds groups to one word and leaves unknown words alone", () => {
    assert.equal(canon("datastore"), canon("database"));
    assert.equal(canon("zebra"), "zebra");
    assert.ok(synonymsOf("car").some((t) => t.startsWith("automobil"))); // the table holds stems
  });
});

describe("CJK, floods and near-duplicates", () => {
  test("M1 a Chinese sentence finds its own note", async () => {
    const s = new Store(":memory:");
    const n = add(s, "x", "note zh", "生产服务器每周日凌晨两点自动重启。");
    for (let i = 0; i < 20; i++) add(s, "x", "filler " + i, `Quarterly planning item ${i} covers budget and roadmap.`);
    assert.equal((await ranks(s, "生产服务器什么时候重启", 5))[0], n.id);
  });
  test("F1 200 near-duplicate updates by a noisy writer do not bury the real postmortem", async () => {
    const s = new Store(":memory:");
    const g = add(s, "human", "Incident postmortem payments outage", "Root cause of the payments outage was an expired TLS certificate on the gateway. Fixed by rotating the certificate.", 20);
    s.transaction(() => {
      for (let i = 0; i < 200; i++) as("noisy", () => s.create({ title: "payments outage update " + i, body: `payments outage status update ${i}: still investigating the payments outage, outage ongoing, payments gateway outage investigating.` }, { skipEdges: true, lint: "none" }));
    });
    assert.ok((await ranks(s, "what caused the payments outage", 10)).indexOf(g.id) < 5);
  });
  test("F3 20 keyword-stuffed same-title decoys leave the real note in the top 3", async () => {
    const s = new Store(":memory:");
    const g = add(s, "human", "Payments outage root cause", "Expired TLS certificate on the gateway caused the payments outage.", 20);
    s.transaction(() => {
      for (let i = 0; i < 20; i++) as("noisy", () => s.create({ title: "Payments outage root cause", body: "Payments outage root cause caused by payments outage payments outage root cause. unknown cause pending " + i }, { skipEdges: true, lint: "none" }));
    });
    assert.ok((await ranks(s, "payments outage root cause", 5)).indexOf(g.id) < 3);
  });
  test("dampenNearDuplicates halves the 2nd copy, keeps the first, and drops nothing", () => {
    const same = { title: "Deploy plan", body: "We deploy the billing service to production every Tuesday morning after the freeze." };
    const out = dampenNearDuplicates([
      { note: same, score: 1 },
      { note: { ...same }, score: 0.9 },
      { note: { title: "Lunch", body: "Lunch is at noon in the kitchen on the second floor with everyone." }, score: 0.8 },
    ]);
    assert.equal(out.length, 3);
    assert.equal(out[0].score, 1);
    assert.equal(out.find((h) => h.note.title === "Lunch")?.score, 0.8);
    assert.equal(out.filter((h) => h.score === 0.45).length, 1);
  });
});
