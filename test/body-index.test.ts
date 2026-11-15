import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// C-06 (1.5.0): with encryption on, keyword search reads an index of the decrypted bodies held only in memory (an attached
// :memory: database on the Store's own connection). Ranking must equal a plain store's, every write path must keep it in
// step, other processes' writes must be caught up, and no body word may reach the database, the WAL or a temp file.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type RankedHit } from "../src/store.js";
import { ensureKey } from "../src/crypto.js";
import { actorStore } from "../src/actor.js";

function withDirs<T>(fn: (plain: string, enc: string) => T): T {
  const plain = mkdtempSync(join(tmpdir(), "om-bi-plain-"));
  const enc = mkdtempSync(join(tmpdir(), "om-bi-enc-"));
  try {
    return fn(plain, enc);
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(enc, { recursive: true, force: true });
  }
}

const encStore = (dir: string, opts: { bodyIndex?: "lazy" | "off" } = {}): Store => {
  ensureKey(dir);
  return new Store(join(dir, "state.db"), opts);
};

/** Deterministic fixture: titles share few words with bodies, so a body-only word proves the body was searched. */
const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split(" ");
function fill(s: Store): void {
  let x = 7;
  const r = (): number => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (n: number): string => Array.from({ length: n }, () => WORDS[Math.floor(r() * r() * WORDS.length)]).join(" ");
  s.transaction(() => {
    for (let i = 0; i < 200; i++) {
      s.create(
        { namespace: i % 3 ? "a" : "b", title: `t${i} ${pick(2)}`, body: `${pick(10 + (i % 17))} body${i % 23}`, tags: i % 5 ? [] : ["tagged"], sensitivity: i % 4 === 0 ? "private" : "internal" },
        { skipEdges: true, lint: "none" }
      );
    }
  });
}

const shape = (hits: RankedHit[]): Array<[number, number]> => hits.map((h) => [h.note.id, h.score]);
function sameRanking(a: RankedHit[], b: RankedHit[], what: string): void {
  assert.equal(a.length, b.length, `${what}: same hit count`);
  a.forEach((h, i) => {
    assert.equal(h.note.id, b[i].note.id, `${what}: same order at ${i}`);
    assert.ok(Math.abs(h.score - b[i].score) < 1e-9, `${what}: same score at ${i} (${h.score} vs ${b[i].score})`);
  });
}
const ids = (s: Store, q: string): number[] => s.searchRanked(q, { anyTerm: true, limit: 200 }).map((h) => h.note.id);

describe("C-06 encrypted body search (in-memory index)", () => {
  test("ranking on an encrypted store equals the plain store: same ids, order and scores", () =>
    withDirs((pd, ed) => {
      const p = new Store(join(pd, "state.db"));
      const e = encStore(ed);
      try {
        fill(p);
        fill(e);
        assert.ok(e.encryptedCount() === 200, "every body is sealed");
        for (const q of ["body7", "kilo lima", "alpha body3", "tango sierra romeo"]) {
          sameRanking(e.searchRanked(q, { limit: 50 }), p.searchRanked(q, { limit: 50 }), `${q} (all terms)`);
          sameRanking(e.searchRanked(q, { limit: 50, anyTerm: true }), p.searchRanked(q, { limit: 50, anyTerm: true }), `${q} (any term)`);
          sameRanking(e.searchRanked(q, { limit: 50, anyTerm: true, namespace: "b" }), p.searchRanked(q, { limit: 50, anyTerm: true, namespace: "b" }), `${q} in b`);
          const capped = (s: Store): RankedHit[] => actorStore.run({ label: "app", authed: true, maxSensitivity: "internal" }, () => s.searchRanked(q, { limit: 50, anyTerm: true }));
          sameRanking(capped(e), capped(p), `${q} under an internal ceiling`);
          assert.ok(capped(e).every((h) => h.note.sensitivity !== "private"), "the ceiling still applies");
        }
        assert.ok(e.searchRanked("body7", { limit: 50 }).length > 0, "a body-only word is found on the encrypted store");
        assert.deepEqual(shape(e.searchRanked("zzznothing")), []);
      } finally {
        p.close();
        e.close();
      }
    }));

  test("every write path keeps the index in step with what a plain store finds", () =>
    withDirs((pd, ed) => {
      const p = new Store(join(pd, "state.db"));
      const e = encStore(ed);
      try {
        const both = <T>(fn: (s: Store) => T): [T, T] => [fn(p), fn(e)];
        const check = (q: string, what: string): void => assert.deepEqual(ids(e, q), ids(p, q), `${what}: ${q}`);
        e.searchRanked("warm"); // build first, so the writes below go through the triggers
        const [a] = both((s) => s.create({ title: "first", body: "the walrus sings", tags: [] }));
        check("walrus", "create");
        both((s) => s.update(a.id, { body: "the pelican sings" }));
        check("walrus", "body update");
        check("pelican", "body update");
        both((s) => s.update(a.id, { title: "renamed heron" }));
        check("pelican", "title update");
        check("heron", "title update");
        both((s) => s.update(a.id, { tags: ["seabird"] }));
        check("seabird", "tags update");
        both((s) => s.archive(a.id));
        check("pelican", "archive");
        assert.deepEqual(ids(e, "pelican"), [], "never found while archived");
        both((s) => s.restore(a.id));
        check("pelican", "restore");
        assert.deepEqual(ids(e, "pelican"), [a.id], "found again after restore");
        const [b] = both((s) => s.create({ title: "second", body: "an octopus waves", tags: [] }));
        both((s) => s.delete(b.id));
        check("octopus", "delete");
        assert.deepEqual(ids(e, "octopus"), []);
      } finally {
        p.close();
        e.close();
      }
    }));

  test("encrypt enable on an existing plain store: the bodies stay searchable", () =>
    withDirs((_pd, ed) => {
      const s = new Store(join(ed, "state.db"));
      try {
        s.create({ title: "plain first", body: "a capybara naps", tags: [] });
        assert.deepEqual(ids(s, "capybara").length, 1);
        s.encryptAll(ensureKey(ed));
        assert.equal(s.encryptedCount(), 1);
        assert.equal(ids(s, "capybara").length, 1, "still found once sealed");
      } finally {
        s.close();
      }
    }));

  test("a rolled-back write leaves no row in the index", () =>
    withDirs((_pd, ed) => {
      const s = encStore(ed);
      try {
        s.searchRanked("warm");
        assert.throws(() =>
          s.transaction(() => {
            s.create({ title: "doomed", body: "a quokka smiles", tags: [] });
            throw new Error("boom");
          })
        );
        assert.deepEqual(ids(s, "quokka"), []);
        assert.equal(s.bodyIndexInfo().notes, 0);
      } finally {
        s.close();
      }
    }));

  test("another connection's writes and deletes are caught up; a pruned change log forces a full rebuild", () =>
    withDirs((_pd, ed) => {
      const s1 = encStore(ed);
      const s2 = new Store(join(ed, "state.db"));
      try {
        s1.create({ title: "one", body: "a narwhal dives", tags: [] });
        assert.equal(ids(s1, "narwhal").length, 1);
        const builds = s1.bodyIndexInfo().builds;
        const n = s2.create({ title: "two", body: "a manatee floats", tags: [] });
        assert.deepEqual(ids(s1, "manatee"), [n.id], "a write by the other connection is seen");
        s2.update(n.id, { body: "a dugong floats" });
        assert.deepEqual(ids(s1, "manatee"), [], "its old words are gone");
        assert.deepEqual(ids(s1, "dugong"), [n.id]);
        s2.delete(n.id);
        assert.deepEqual(ids(s1, "dugong"), [], "a delete by the other connection is seen");
        assert.equal(s1.bodyIndexInfo().builds, builds, "caught up from the change log, no rebuild");
        // The other side writes, then the log is cleared past our watermark: only a rebuild can be right.
        const m = s2.create({ title: "three", body: "a platypus paddles", tags: [] });
        s2.purgeChangeLogAll();
        assert.deepEqual(ids(s1, "platypus"), [m.id]);
        assert.equal(s1.bodyIndexInfo().builds, builds + 1, "rebuilt once");
      } finally {
        s1.close();
        s2.close();
      }
    }));

  test("a catch-up made inside a transaction that rolls back is made again afterwards", () =>
    withDirs((_pd, ed) => {
      const s1 = encStore(ed);
      const s2 = new Store(join(ed, "state.db"));
      try {
        s1.searchRanked("warm");
        const n = s2.create({ title: "other", body: "an axolotl smiles", tags: [] });
        assert.throws(() =>
          s1.transaction(() => {
            assert.deepEqual(ids(s1, "axolotl"), [n.id], "seen inside the transaction");
            throw new Error("boom");
          })
        );
        assert.deepEqual(ids(s1, "axolotl"), [n.id], "still seen after the rollback undid the replay");
      } finally {
        s1.close();
        s2.close();
      }
    }));

  test("a body that cannot be decrypted never aborts a write; it is counted and the rest stay searchable", () =>
    withDirs((_pd, ed) => {
      const s = encStore(ed);
      try {
        const a = s.create({ title: "good", body: "a meerkat stands", tags: [] });
        const b = s.create({ title: "bad", body: "a lemur leaps", tags: [] });
        s.searchRanked("warm");
        s.db.prepare("UPDATE notes SET body_enc = 'v2:garbage' WHERE id = ?").run(b.id);
        assert.equal(s.bodyIndexInfo().errors, 1);
        const c = s.create({ title: "later", body: "a gecko climbs", tags: [] });
        assert.deepEqual(ids(s, "meerkat"), [a.id]);
        assert.deepEqual(ids(s, "gecko"), [c.id]);
      } finally {
        s.close();
      }
    }));

  test("no body word reaches the database, the WAL or a temp file", () =>
    withDirs((_pd, ed) => {
      const words = ["xylophonequartz", "zebrafinchmarble", "quasarpumpkin"];
      const s = encStore(ed);
      try {
        s.create({ title: "secret one", body: `remember ${words[0]} please`, tags: [] });
        s.searchRanked(words[0]);
        s.create({ title: "secret two", body: `and ${words[1]} too`, tags: [] });
        s.update(1, { body: `now ${words[2]}` });
        assert.equal(ids(s, words[2]).length, 1, "the index is live");
        const files = [
          ...readdirSync(ed).map((f) => join(ed, f)),
          ...readdirSync(tmpdir()).filter((f) => f.startsWith("etilqs_")).map((f) => join(tmpdir(), f)),
        ];
        for (const f of files) {
          let bytes: string;
          try {
            bytes = readFileSync(f).toString("latin1");
          } catch {
            continue; // a directory or a file held open exclusively
          }
          for (const w of words) assert.ok(!bytes.includes(w), `${w} found in ${f}`);
        }
      } finally {
        s.close();
      }
    }));

  test("bodyIndex: 'off' (the hooks) and MONOMEM_BODY_INDEX=off keep title-and-tag search", () =>
    withDirs((_pd, ed) => {
      const s = encStore(ed);
      s.create({ title: "hook one", body: "a wombat digs", tags: [] });
      s.close();
      const off = encStore(ed, { bodyIndex: "off" });
      try {
        assert.deepEqual(ids(off, "wombat"), []);
        assert.equal(off.bodyIndexInfo().state, "off");
      } finally {
        off.close();
      }
      process.env.MONOMEM_BODY_INDEX = "off";
      try {
        const envOff = encStore(ed);
        try {
          assert.deepEqual(ids(envOff, "wombat"), []);
        } finally {
          envOff.close();
        }
      } finally {
        delete process.env.MONOMEM_BODY_INDEX;
      }
    }));
});

const ROOT = join(import.meta.dirname, "..", "..");

test("hook processes never build the body index (session-start time budget): every Store they open passes bodyIndex 'off'", () => {
  for (const f of ["src/hook.ts", "src/recall.ts", "src/file-context.ts"]) {
    const opens = readFileSync(join(ROOT, f), "utf8").match(/new Store\([^)]*\)/g) ?? [];
    assert.ok(opens.length > 0, `${f} opens a Store`);
    for (const o of opens) assert.match(o, /bodyIndex: "off"/, `${f}: ${o}`);
  }
});

test("servers warm the body index just after start-up", () => {
  for (const f of ["src/start.ts", "src/index.ts", "src/mcp-http.ts", "src/mcp-stdio.ts"]) {
    assert.match(readFileSync(join(ROOT, f), "utf8"), /setImmediate\(\(\) => store\.warmBodyIndex\(\)\)/, f);
  }
});
