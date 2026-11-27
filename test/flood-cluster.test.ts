// r6: one writer floods a cluster of near-identical, keyword-stuffed notes (h2h case F3). The 4th and later members of a cluster
// (word overlap >= CLUSTER_JACCARD with 3+ higher-scored hits) are scaled by 0.25; distinct notes and short version chains are untouched.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { runSearch } from "../src/search-service.js";
import { dampenNearDuplicates } from "../src/search-diversity.js";

const iso = (d: number): string => new Date(Date.now() - d * 864e5).toISOString();
const add = (s: Store, title: string, body: string, age = 0) =>
  s.create({ title, body, created_at: iso(age) }, { skipEdges: false, lint: "none", updatedAt: iso(age) });

describe("flood cluster", () => {
  test("a single writer's 20 stuffed decoys do not bury the real note", async () => {
    const s = new Store(":memory:");
    const good = add(s, "Payments outage root cause", "An expired TLS certificate on the gateway caused the payments outage.", 20);
    for (let i = 0; i < 20; i++) add(s, "Payments outage root cause", `Payments outage root cause caused by payments outage payments outage root cause. unknown cause pending ${i}`, 1);
    for (let i = 0; i < 20; i++) add(s, `filler ${i}`, `Quarterly planning item ${i} covers budget, hiring and roadmap tradeoffs for team ${i % 7}.`);
    const ids = (await runSearch(s, "payments outage root cause", { mode: "keyword", limit: 50 })).map((n) => n.id);
    assert.ok(ids.indexOf(good.id) >= 0 && ids.indexOf(good.id) < 5, `rank ${ids.indexOf(good.id) + 1}`);
  });
  test("three versions of one fact are not a cluster: order untouched", () => {
    const mk = (t: string, sc: number) => ({ note: { id: sc * 10, rev: 1, title: "Release codename", body: `The release codename is ${t}.` }, score: sc });
    const out = dampenNearDuplicates([mk("alpha", 3), mk("bravo", 2), mk("charlie", 1)]);
    assert.deepEqual(out.map((h) => h.score), [3, 2, 1]);
  });
  test("cluster members past the third are scaled by 0.25, others kept", () => {
    const mk = (i: number, sc: number) => ({ note: { id: i, rev: 1, title: "Outage root cause", body: `outage root cause caused by outage outage unknown pending n${i}` }, score: sc });
    const hits = [mk(1, 10), mk(2, 9), mk(3, 8), mk(4, 7), mk(5, 6)];
    const out = dampenNearDuplicates(hits);
    assert.deepEqual(out.map((h) => h.score), [10, 9, 8, 1.75, 1.5]);
  });
});
