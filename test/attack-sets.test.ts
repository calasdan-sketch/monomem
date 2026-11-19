// `monomem check --attacks --set <name>`: published outside attack sets replayed on a COPY of the store, every miss shown.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { drillMain, runDrill, renderDrill } from "../src/drill.js";
import { ATTACK_SETS, attackHalf, fetchChecked, findSet, renderAttackSet, runAttackSet, sampleVerdict } from "../src/attack-sets/index.js";

// Private temp root, so the leftover check is not confused by other test files running at the same time.
const privateTmp = mkdtempSync(join(tmpdir(), "attacksets-tmproot-"));
const savedTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
before(() => void Object.assign(process.env, { TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp }));
after(() => {
  for (const [k, v] of Object.entries(savedTmp)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(privateTmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const leftovers = (): string[] => readdirSync(tmpdir()).filter((f) => f.startsWith("monomem-drill-") || f.startsWith("monomem-bench-"));

function makeStore(n: number): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "attacksets-test-"));
  const db = join(dir, "state.db");
  const s = new Store(db);
  for (let i = 0; i < n; i++) s.create({ title: `Ordinary note ${i}`, body: `Nothing special about item ${i}.` });
  s.close();
  return { dir, db };
}

describe("outside attack sets", () => {
  test("the shipped sets: sizes, unique ids, licence, and only poisonedrag-nq downloads", async () => {
    const sizes: Record<string, number> = { injecagent: 62, "injecagent-enhanced": 62, agentdojo: 27, minja: 6, poisonedrag: 10, "lint-evasion": 61, "tool-steer": 21 };
    for (const s of ATTACK_SETS) {
      assert.equal(s.licence, "MIT", s.name);
      if (s.download) {
        assert.equal(s.name, "poisonedrag-nq");
        assert.match(s.download.url, /^https:\/\/raw\.githubusercontent\.com\/sleeepeer\/PoisonedRAG\/[0-9a-f]{40}\//, "pinned to a commit");
        assert.match(s.download.sha256, /^[0-9a-f]{64}$/);
        continue;
      }
      const samples = await s.samples();
      assert.equal(samples.length, sizes[s.name], s.name);
      assert.equal(new Set(samples.map((x) => x.id)).size, samples.length, `${s.name}: ids are unique`);
      assert.ok(samples.every((x) => x.text.trim().length > 0));
    }
    assert.deepEqual(Object.keys(sizes).sort(), ATTACK_SETS.filter((s) => !s.download).map((s) => s.name).sort());
  });

  test("verdicts: held / blocked / warned / REACHED", () => {
    assert.equal(sampleVerdict({ outcome: "quarantined" }, false).verdict, "held");
    assert.equal(sampleVerdict({ outcome: "invalid", detail: "secret" }, false).verdict, "blocked");
    assert.equal(sampleVerdict({ outcome: "ok" }, false).verdict, "blocked", "stored but never served");
    assert.equal(sampleVerdict({ outcome: "ok", data: { warnings: [{ category: "directive", label: "deferred trigger" }] } }, true).verdict, "warned");
    assert.deepEqual(sampleVerdict({ outcome: "ok" }, true), { verdict: "reached", why: "stored and served with no warning" });
  });

  test("a downloaded file is used only when its SHA-256 matches", async () => {
    const body = '{"a":1}';
    const url = `data:application/json,${encodeURIComponent(body)}`;
    const good = createHash("sha256").update(body).digest("hex");
    assert.equal(await fetchChecked(url, good), body);
    await assert.rejects(fetchChecked(url, "0".repeat(64)), /checksum mismatch .* Nothing was run/);
  });

  test("replays on a copy: the real store is byte-for-byte unchanged, nothing is left behind, every miss is listed", async () => {
    const { dir, db } = makeStore(20);
    try {
      const bytes = readFileSync(db);
      const enhanced = await runAttackSet({ dbPath: db, set: findSet("injecagent-enhanced")! });
      assert.equal(enhanced.samples, 62);
      assert.equal(enhanced.notes, 20);
      assert.equal(enhanced.counts.held, 62, "the fixed override sentence is held every time");
      const minja = await runAttackSet({ dbPath: db, set: findSet("minja")! });
      // MINJA plants a false fact with no command words: the linter does not see it. A known miss, shown as REACHED.
      assert.equal(minja.counts.reached, 6);
      const text = renderAttackSet(minja);
      assert.match(text, /REACHED  ehr-1/);
      assert.match(text, /REACHED 6 of 6/);
      assert.match(text, /does not mean an agent would act on it/);
      for (const r of [enhanced, minja]) assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.samples);
      assert.ok(readFileSync(db).equals(bytes), "the real database file is unchanged");
      assert.deepEqual(leftovers(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("CLI: --half a|b runs one fixed half; a bad or lone --half is refused", async () => {
    const { dir, db } = makeStore(3);
    const prev = process.env.MONOMEM_DB_PATH;
    process.env.MONOMEM_DB_PATH = db;
    const lines: string[] = [];
    const origErr = console.error;
    const errors: string[] = [];
    console.error = (s: string) => void errors.push(s);
    try {
      const all = await findSet("injecagent")!.samples();
      const a = all.filter((s) => attackHalf(s.id) === "a").map((s) => s.id);
      assert.ok(a.length > 0 && a.length < all.length);
      assert.equal(await drillMain(["--set", "injecagent", "--half", "a", "--json"], (s) => lines.push(s)), 0);
      const r = JSON.parse(lines.at(-1)!) as { half: string; rows: Array<{ id: string }> };
      assert.equal(r.half, "a");
      assert.deepEqual(r.rows.map((x) => x.id), a);
      assert.equal(await drillMain(["--set=agentdojo", "--half=b"], (s) => lines.push(s)), 0);
      assert.match(lines.at(-1)!, /half b only: held out, never tuned on/);
      assert.equal(await drillMain(["--set", "injecagent", "--half", "c"], (s) => lines.push(s)), 2);
      assert.equal(await drillMain(["--half", "a"], (s) => lines.push(s)), 2);
      assert.match(errors.join("\n"), /--half needs a or b[\s\S]*--half works only with --set/);
    } finally {
      console.error = origErr;
      if (prev === undefined) delete process.env.MONOMEM_DB_PATH;
      else process.env.MONOMEM_DB_PATH = prev;
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("CLI: --set list, unknown set, and the plain drill output is unchanged", async () => {
    const { dir, db } = makeStore(3);
    const prev = process.env.MONOMEM_DB_PATH;
    process.env.MONOMEM_DB_PATH = db;
    const lines: string[] = [];
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (s: string) => void errors.push(s);
    try {
      assert.equal(await drillMain(["--set", "list"], (s) => lines.push(s)), 0);
      assert.match(lines.join("\n"), /poisonedrag-nq .*\[downloads at run time\]/);
      assert.equal(await drillMain(["--set", "nope"], (s) => lines.push(s)), 2);
      assert.match(errors.join("\n"), /no attack set named "nope"/);
      assert.equal(await drillMain(["--set=agentdojo", "--json"], (s) => lines.push(s)), 0);
      const r = JSON.parse(lines.at(-1)!) as { set: string; samples: number; version: string; date: string };
      assert.equal(r.set, "agentdojo");
      assert.equal(r.samples, 27);
      assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
      const plain: string[] = [];
      assert.equal(await drillMain([], (s) => plain.push(s)), 0);
      assert.equal(plain.join("\n"), renderDrill({ ...(await runDrill({ dbPath: db })), elapsed_ms: 0 }), "the 26-attack drill prints what it printed before");
    } finally {
      console.error = origErr;
      if (prev === undefined) delete process.env.MONOMEM_DB_PATH;
      else process.env.MONOMEM_DB_PATH = prev;
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
