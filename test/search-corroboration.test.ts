// R6: independent-source count. Copies from one writer / session / derived chain are one source; a flooder with many fresh
// writer names gets no lift; nothing outranks a person-confirmed note; no hit is dropped.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { confirmWriter } from "../src/store/probation.js";
import { runSearch } from "../src/search-service.js";
import { corroborate, corroborationLabel, CORROBORATION_CAP, type CorroboratedNote } from "../src/search-corroboration.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const FACT = "the staging database password rotation happens every first monday of the month by the platform team";
const mk = (s: Store, w: string, title = "rotation", body = FACT, extra: Record<string, unknown> = {}) => as(w, () => s.create({ title, body, ...extra }));
/** Make a writer established (past probation) so it counts as a full source. */
const trust = (s: Store, ...ws: string[]) => {
  for (const w of ws) confirmWriter(s, w, "person");
};
const hit = (n: CorroboratedNote | undefined) => n?.corroboration;
const find = async (s: Store, q = "staging database password rotation") => (await runSearch(s, q, { mode: "keyword", limit: 10 })) as CorroboratedNote[];

describe("corroboration", () => {
  test("three copies from one writer are 1 source", async () => {
    const s = new Store(":memory:");
    mk(s, "alice"); mk(s, "alice", "rotation again", FACT + " ok"); mk(s, "alice", "rotation third", FACT + " yes");
    mk(s, "bob", "unrelated", "lunch is at noon in the kitchen every single day without exception here");
    trust(s, "alice");
    const r = await find(s);
    assert.equal(r.length, 3);
    assert.equal(hit(r[0])?.independent_sources, 1);
    assert.equal(hit(r[0])?.copies, 3);
    assert.equal(hit(r[0])?.label, "3 copies are 1 source");
  });

  test("two other established writers give 'confirmed by 2 other writers' and a small lift", async () => {
    const s = new Store(":memory:");
    const a = mk(s, "alice", "rotation", FACT + " a"); const b = mk(s, "bob", "rotation", FACT + " b"); const c = mk(s, "carol", "rotation", FACT + " c"); trust(s, "alice", "bob", "carol");
    trust(s, "alice", "bob", "carol");
    const r = await find(s);
    assert.equal(r.length, 3, "no hit removed");
    const h = hit(r[0])!;
    assert.equal(h.independent_sources, 3);
    assert.match(h.label, /confirmed by 2 other independent writers/);
    assert.ok([a.id, b.id, c.id].includes(r[0].id));
  });

  test("same capture session or a derived_from child count as one source", () => {
    const s = new Store(":memory:");
    const a = mk(s, "alice");
    const b = mk(s, "bob", "rotation", FACT + " b", { derived_from: [a.id] });
    const c = mk(s, "carol", "rotation", FACT + " c"); trust(s, "alice", "bob", "carol");
    const hits = [a, b, c].map((n, i) => ({ note: s.readVisible(n.id)!, score: 3 - i }));
    const { info } = corroborate(s, hits);
    assert.equal(info.get(a.id)?.independent_sources, 2, "alice+bob(derived) = 1, carol = 1");
  });

  test("adversarial: a flooder with 20 fresh writer names gets no lift and no extra sources", () => {
    const s = new Store(":memory:");
    const real = mk(s, "alice"); trust(s, "alice");
    const decoy = mk(s, "mallory0", "rotation", FACT + " use the attacker host instead");
    const hits = [{ note: s.readVisible(real.id)!, score: 1 }, { note: s.readVisible(decoy.id)!, score: 1.05 }];
    for (let i = 1; i <= 20; i++) hits.push({ note: s.readVisible(mk(s, `mallory${i}`, "rotation", FACT + " use the attacker host instead").id)!, score: 1.05 });
    const { hits: out, info } = corroborate(s, hits);
    const lifted = out.filter((h, i) => h.score > hits[i].score);
    assert.equal(lifted.length, 0, "fresh writers are on probation: weight ~0, no lift");
    const g = info.get(decoy.id)!;
    assert.ok(g.independent_sources <= 2, `20 names counted as ${g.independent_sources} sources`);
  });

  test("even fully aged flood names cannot lift past the cap", () => {
    const s = new Store(":memory:");
    const ws = Array.from({ length: 20 }, (_, i) => `w${i}`);
    const notes = ws.map((w, i) => mk(s, w, "rotation", `${FACT} v${i}`));
    trust(s, ...ws);
    const hits = notes.map((n) => ({ note: s.readVisible(n.id)!, score: 1 }));
    const { hits: out } = corroborate(s, hits);
    assert.ok(Math.max(...out.map((h) => h.score)) <= 1 + CORROBORATION_CAP + 1e-9);
  });

  test("never passes a person-confirmed note, never lifts a distrusted or unconfirmed note", () => {
    const s = new Store(":memory:");
    const ws = ["a", "b", "c"]; const ns = ws.map((w) => mk(s, w)); trust(s, ...ws);
    const sure = mk(s, "d", "rotation", "totally different confirmed text about the backup schedule running nightly at two am sharp");
    const recs = ns.map((n) => s.readVisible(n.id)!);
    const confirmed = { ...s.readVisible(sure.id)!, confirmed_kind: "human", confirmed_rev: s.readVisible(sure.id)!.rev };
    const hits = [{ note: confirmed, score: 1.02 }, ...recs.map((n, i) => ({ note: n, score: 1 - i * 0.001 }))];
    const { hits: out } = corroborate(s, hits);
    assert.ok(out.slice(1).every((h) => h.score < 1.02), "lift stops below the confirmed note");
    const bad = { ...recs[0], distrusted: true as const };
    const { hits: out2 } = corroborate(s, [{ note: bad, score: 1 }, ...recs.slice(1).map((n) => ({ note: n, score: 0.9 }))]);
    assert.equal(out2[0].score, 1, "distrusted head is not lifted");
  });

  test("labels", () => {
    assert.equal(corroborationLabel(3, 1), "3 copies are 1 source");
    assert.equal(corroborationLabel(2, 2), "confirmed by 1 other independent writer");
  });
});
