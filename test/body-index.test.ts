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
import { supersedePreview, supersedeConfirm, supersedeUndo } from "../src/supersede.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AddressInfo } from "node:net";

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

  test("rarity weights (prefixDocFreqs) read the in-memory index and equal the plain store's", () =>
    withDirs((pd, ed) => {
      const p = new Store(join(pd, "state.db"));
      const e = encStore(ed);
      try {
        fill(p);
        fill(e);
        e.searchRanked("warm"); // a search brings the body index up, as anyKeywordHits does before reading the weights
        const terms = ["body7", "kilo", "alpha", "zzznothing"];
        const a = e.prefixDocFreqs(terms);
        const b = p.prefixDocFreqs(terms);
        assert.equal(a.n, b.n);
        assert.deepEqual([...a.df], [...b.df]);
        assert.ok((a.df.get("body7") ?? 0) > 0, "a body-only word is counted on the encrypted store");
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

describe("C-06 gaps: other write paths, and a fallback is never silent", () => {
  const asAdmin = <T>(fn: () => T): T => actorStore.run({ label: "cli", authed: true }, fn);

  test("supersede and its undo keep the index current", () =>
    withDirs((pd, ed) => {
      const p = new Store(join(pd, "state.db"));
      const e = encStore(ed);
      try {
        e.searchRanked("warm");
        const caller = { scope: "admin" as const, writer: "cli" };
        for (const s of [p, e]) {
          const old = asAdmin(() => s.create({ title: "rotation", body: "rotates on tuesday with a kestrel", tags: [] }));
          const new_note = { title: "rotation now", body: "rotates on monday with a falcon" };
          const pv = asAdmin(() => supersedePreview(s, caller, { old_ids: [old.id], new_note }));
          asAdmin(() => supersedeConfirm(s, caller, { token: pv.token, new_note }));
        }
        for (const q of ["kestrel", "falcon"]) assert.deepEqual(ids(e, q), ids(p, q), `after supersede: ${q}`);
        assert.equal(ids(e, "falcon").length, 1);
        for (const s of [p, e]) asAdmin(() => supersedeUndo(s, caller, 1));
        for (const q of ["kestrel", "falcon"]) assert.deepEqual(ids(e, q), ids(p, q), `after undo: ${q}`);
        assert.equal(ids(e, "kestrel").length, 1, "the old note is found again");
      } finally {
        p.close();
        e.close();
      }
    }));

  test("delete, history purge and the scrub (VACUUM) keep the index current", () =>
    withDirs((_pd, ed) => {
      const s = encStore(ed);
      try {
        const a = s.create({ title: "keep", body: "an ibis wades", tags: [] });
        const b = s.create({ title: "drop", body: "a heron waits", tags: [] });
        s.update(a.id, { body: "an ibis wades and a stork flies" });
        assert.equal(ids(s, "stork").length, 1);
        s.delete(b.id);
        s.purgeHistory(a.id);
        s.scrubPlaintext({ maxVacuumBytes: Number.MAX_SAFE_INTEGER });
        assert.deepEqual(ids(s, "heron"), [], "a deleted note is gone from the index");
        assert.deepEqual(ids(s, "stork"), [a.id], "after the VACUUM the index still answers");
        const c = s.create({ title: "after", body: "a crane dances", tags: [] });
        assert.deepEqual(ids(s, "crane"), [c.id], "and still follows new writes");
      } finally {
        s.close();
      }
    }));

  test("an import (restore) is searchable by body word, also from another process", async () => {
    const ed = mkdtempSync(join(tmpdir(), "om-bi-imp-"));
    ensureKey(ed);
    const s1 = new Store(join(ed, "state.db"));
    const s2 = new Store(join(ed, "state.db"));
    try {
      s1.searchRanked("warm");
      const r1 = await s1.importNotes([{ namespace: "default", title: "imported one", body: "a puffin nests", tags: [] }]);
      assert.equal(r1.length, 1, "imported");
      assert.equal(ids(s1, "puffin").length, 1, "this process's import");
      await s2.importNotes([{ namespace: "default", title: "imported two", body: "a gannet dives", tags: [] }]);
      assert.equal(ids(s1, "gannet").length, 1, "another process's import");
    } finally {
      s1.close();
      s2.close();
      rmSync(ed, { recursive: true, force: true });
    }
  });

  test("a search inside a write before the index exists falls back, and says so: counted, with the reason", () =>
    withDirs((_pd, ed) => {
      const s = encStore(ed);
      try {
        s.create({ title: "in tx", body: "a toucan calls", tags: [] });
        const found = s.transaction(() => ids(s, "toucan"));
        assert.deepEqual(found, [], "titles and tags only inside the write");
        const info = s.bodyIndexInfo();
        assert.equal(info.fallbacks, 1);
        assert.match(info.lastFallback ?? "", /inside a write/);
        assert.match(s.bodySearchNotice(0) ?? "", /bodies were not searched/);
        assert.equal(s.bodySearchNotice(1), null, "nothing new since the caller's mark");
        assert.equal(ids(s, "toucan").length, 1, "the next search builds it");
      } finally {
        s.close();
      }
    }));

  test("over the (injectable) size cap: state 'too large', every search counted, and REST and MCP replies carry the notice", async () => {
    const ed = mkdtempSync(join(tmpdir(), "om-bi-cap-"));
    ensureKey(ed);
    const s = new Store(join(ed, "state.db"), { bodyIndexMaxNotes: 2 });
    const srv = createApiServer(s, "body-index-cap-token-0123456789abcdef");
    try {
      for (const w of ["one", "two", "three"]) s.create({ title: `cap ${w}`, body: `a ${w} flamingo`, tags: [] });
      assert.deepEqual(ids(s, "flamingo"), []);
      assert.equal(s.bodyIndexInfo().state, "too large");
      assert.equal(s.bodyIndexInfo().fallbacks, 1);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const h = { authorization: "Bearer body-index-cap-token-0123456789abcdef", "content-type": "application/json" };
      const search = await (await fetch(`${base}/search?q=flamingo`, { headers: h })).json();
      assert.match(String(search.body_search), /bodies were not searched.*100|not built above 2/, JSON.stringify(search));
      const rel = await (await fetch(`${base}/relevant`, { method: "POST", headers: h, body: JSON.stringify({ message: "any flamingo?" }) })).json();
      assert.match(String(rel.body_search), /bodies were not searched/, JSON.stringify(rel));
      const status = await (await fetch(`${base}/status`, { headers: h })).json();
      assert.equal(status.body_index.state, "too large");
      assert.ok(status.body_index.fallbacks >= 3, JSON.stringify(status));
      assert.equal((await fetch(`${base}/status`)).status, 401, "the detail needs a key");
      const health = await (await fetch(`${base}/health`)).json();
      assert.deepEqual(Object.keys(health).sort(), ["schema", "status", "version"], "/health stays minimal");
      const mcp = createMcpServer(s, "admin");
      const [c, t] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1.0.0" });
      await Promise.all([mcp.connect(t), client.connect(c)]);
      const r = (await client.callTool({ name: "state_search", arguments: { query: "flamingo" } })) as { content: Array<{ text: string }> };
      assert.match(r.content[0].text, /"body_search":"[^"]*bodies were not searched/, r.content[0].text);
      await client.close();
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      s.close();
      rmSync(ed, { recursive: true, force: true });
    }
  });
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

describe("final3: the size cap holds after the build, and a refused build lets go of the index (ARCH-L1/L2, PERF-S2)", () => {
  const tempTriggers = (s: Store): number => Number((s.db.prepare("SELECT COUNT(*) AS c FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'om_bodyidx_%'").get() as { c: number }).c);

  test("this process's own writes past the cap: the next search says too large and the index and its triggers are gone", () =>
    withDirs((_pd, ed) => {
      ensureKey(ed);
      const s = new Store(join(ed, "state.db"), { bodyIndexMaxNotes: 3 });
      try {
        for (const w of ["one", "two"]) s.create({ title: `t ${w}`, body: `a ${w} heron`, tags: [] });
        assert.equal(ids(s, "heron").length, 2);
        assert.equal(s.bodyIndexInfo().state, "ready");
        assert.equal(tempTriggers(s), 4, "three write triggers and the catch-up (redo) trigger");
        for (const w of ["three", "four"]) s.create({ title: `t ${w}`, body: `a ${w} heron`, tags: [] });
        assert.deepEqual(ids(s, "heron"), []);
        assert.equal(s.bodyIndexInfo().state, "too large");
        assert.equal(tempTriggers(s), 0, "writes no longer pay for an index no search reads");
      } finally {
        s.close();
      }
    }));

  test("another process's writes past the cap, then a rebuild refused for size: index and triggers torn down", () =>
    withDirs((_pd, ed) => {
      ensureKey(ed);
      const s1 = new Store(join(ed, "state.db"), { bodyIndexMaxNotes: 3 });
      const s2 = new Store(join(ed, "state.db"));
      try {
        s1.create({ title: "x", body: "an ibis", tags: [] });
        assert.equal(ids(s1, "ibis").length, 1);
        for (const w of ["b", "c", "d"]) s2.create({ title: w, body: `an ibis ${w}`, tags: [] });
        s2.purgeChangeLogAll(); // only a full rebuild can be right now, and it is over the cap
        assert.deepEqual(ids(s1, "ibis"), []);
        assert.equal(s1.bodyIndexInfo().state, "too large");
        assert.equal(tempTriggers(s1), 0);
      } finally {
        s1.close();
        s2.close();
      }
    }));

  test("final4 N-2: a cap teardown inside a transaction that rolls back is done again by the next search outside it", () =>
    withDirs((_pd, ed) => {
      ensureKey(ed);
      const s = new Store(join(ed, "state.db"), { bodyIndexMaxNotes: 3 });
      try {
        for (const w of ["one", "two"]) s.create({ title: `t ${w}`, body: `a ${w} plover`, tags: [] });
        assert.equal(ids(s, "plover").length, 2);
        assert.equal(tempTriggers(s), 4, "three write triggers and the catch-up (redo) trigger");
        assert.throws(() =>
          s.transaction(() => {
            for (const w of ["three", "four"]) s.create({ title: `t ${w}`, body: `a ${w} plover`, tags: [] });
            assert.deepEqual(ids(s, "plover"), [], "over the cap inside the transaction");
            throw new Error("boom");
          })
        );
        assert.equal(tempTriggers(s), 4, "the rollback brought the triggers back");
        assert.deepEqual(ids(s, "plover"), []);
        assert.equal(s.bodyIndexInfo().state, "too large");
        assert.equal(tempTriggers(s), 0, "the next search outside the transaction lets go of the triggers");
        const attached = s.db.prepare("PRAGMA database_list").all() as Array<{ name: string }>;
        assert.ok(!attached.some((d) => d.name === "bodyidx"), JSON.stringify(attached));
      } finally {
        s.close();
      }
    }));

  test("the build covers every note when ids are far apart (it runs in id ranges)", () =>
    withDirs((_pd, ed) => {
      const s = encStore(ed);
      try {
        const first = s.create({ title: "a", body: "a lone egret", tags: [] });
        s.db.exec("UPDATE sqlite_sequence SET seq = 4500 WHERE name = 'notes'");
        const far = s.create({ title: "b", body: "another egret", tags: [] });
        assert.ok(far.id > 4500, String(far.id));
        assert.deepEqual(ids(s, "egret").sort((a, b) => a - b), [first.id, far.id]);
      } finally {
        s.close();
      }
    }));
});
