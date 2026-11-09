// Aggregation questions ("how many ...") widen k and soft-cap hits per capture session; results carry a compact date.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { runSearch, capPerSession, describeWhen } from "../src/search-service.js";

test("an aggregating question returns twice the results; everyday 'every'/'each' does not", async () => {
  const s = new Store(":memory:");
  for (let i = 0; i < 6; i++) s.create({ title: `Gym visit ${i}`, body: `gym workout log entry ${i} gym gym gym`, source: "A" }, {});
  for (let i = 0; i < 3; i++) s.create({ title: `Short note ${i}`, body: `gym ${i}`, source: `B${i}` }, {});
  const hits = await runSearch(s, "how many times did I go to the gym", { mode: "keyword", limit: 3 });
  assert.equal(hits.length, 6, "limit 3 widened to 6");
  // `source` names a writer or origin, not a session: notes sharing it are not pushed back.
  assert.ok(hits.slice(0, 3).every((n) => n.source === "A"), "source is not a session");
  assert.equal((await runSearch(s, "gym workout log", { mode: "keyword", limit: 3 })).length, 3, "other questions keep their limit");
  assert.equal((await runSearch(s, "every time I log a gym workout", { mode: "keyword", limit: 3 })).length, 3, "'every' alone is not aggregating");
  s.close();
});

test("capPerSession keeps order, drops nothing, ignores notes without a session", () => {
  const n = (id: number, session_id?: string) => ({ id, session_id, source: "" }) as never;
  const out = capPerSession([n(1, "a"), n(2, "a"), n(3, "a"), n(4), n(5, "b")], 2).map((x: { id: number }) => x.id);
  assert.deepEqual(out, [1, 2, 4, 5, 3]);
});

test("describeWhen gives the date and a compact age", () => {
  const now = new Date("2023-10-02T00:00:00Z");
  assert.equal(describeWhen("2023-05-08T10:00:00Z", now, true), "2023-05-08, 5 months before 2023-10-02");
  assert.equal(describeWhen("2023-05-08T10:00:00Z", now), "2023-05-08, 5 months ago");
  assert.equal(describeWhen("2023-09-29T10:00:00Z", now), "2023-09-29, 2 days ago");
  assert.equal(describeWhen("nope", now), "");
});
