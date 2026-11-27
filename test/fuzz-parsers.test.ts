// Property tests for the pure functions and parsers that take untrusted text: no throw (importers may throw a plain Error with a message,
// never a TypeError/RangeError), bounded time, and the invariants each one promises. Seeded and replayable.
// MONOMEM_FUZZ_PARSER_N (default 150) sets the cases per property; MONOMEM_FUZZ_FIRST the first seed.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, ValidationError } from "../src/store.js";
import { cjkBigrams, MAX_BIGRAMS } from "../src/store/cjk-search.js";
import { flagConflict } from "../src/conflict-detect.js";
import { parseTimePhrase } from "../src/time-parse.js";
import { corroborate } from "../src/search-corroboration.js";
import { chunkBody, splitSections, parseFrontmatter } from "../src/claude-import.js";
import { readEngram, readAgentMemory, readAiMemory } from "../src/importers/rivals.js";
import { readNotion } from "../src/importers/notion.js";
import { readZipMarkdown } from "../src/importers/zip.js";
import { readChatSession } from "../src/chat-import.js";
import { rng } from "./fuzz-model-lib.js";
import { ADVERSARIAL, timeMs } from "./fuzz-text-inputs.js";
import { FUNCTIONS } from "./fuzz-targets.js";
import { slow } from "./setup-env.js";

const N = Number(process.env.MONOMEM_FUZZ_PARSER_N ?? 150);
const FIRST = Number(process.env.MONOMEM_FUZZ_FIRST ?? 1);
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "..", "test", "fixtures", "importers");

const pick = <T>(r: () => number, a: readonly T[]): T => a[Math.floor(r() * a.length)];
const sentence = (r: () => number, vocab: readonly string[], n: number): string => Array.from({ length: n }, () => pick(r, vocab)).join(" ");

// ---------- 1. time against length (the 1 MB sweep is bench/fuzz-regex-time.mjs) ----------
test("every text function stays linear on adversarial input (4 KB -> 128 KB: well under 200x the time)", () => {
  const slowOnes: string[] = [];
  for (const [fname, fn] of Object.entries(FUNCTIONS)) {
    for (const [iname, gen] of Object.entries(ADVERSARIAL)) {
      const small = gen(4096), big = gen(131072);
      fn(small); // warm up
      const a = Math.max(timeMs(() => fn(small)), 0.2), b = timeMs(() => fn(big));
      if (b > slow(1500) || (b > 100 && b / a > 200)) slowOnes.push(`${fname}/${iname}: ${a.toFixed(1)} ms -> ${b.toFixed(1)} ms`);
    }
  }
  assert.deepEqual(slowOnes, []);
});

// ---------- 2. search text injection ----------
const FTS_PIECES = ['"', "'", "*", "^", "(", ")", "-", "+", ":", "{", "}", "NEAR(", "NEAR/3", "OR", "AND", "NOT", "title:", "body:", "tags:", "rank", "AAA", "é", "日本", "😀", "\\", "\0", "%", "_", ";", "--", "/*", "x'41'", "tkfind", ",", "."];
test("search never throws on random punctuation, quotes, NEAR/OR/* and column filters, and only returns real live notes", () => {
  const s = new Store(":memory:");
  const note = s.create({ title: "tkfind alpha", body: "beta gamma" });
  s.create({ title: "other note", body: "delta" });
  const gone = s.create({ title: "tkfind archived", body: "x" });
  s.archive(gone.id);
  const live = new Set(s.listIds({ limit: 100 }));
  for (let seed = FIRST; seed < FIRST + N * 4; seed++) {
    const r = rng(seed);
    const q = Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(r, FTS_PIECES)).join(r() < 0.5 ? " " : "");
    for (const any of [false, true]) {
      let hits: Array<{ note: { id: number } }> = [];
      try {
        hits = s.searchRanked(q, { limit: 20, anyTerm: any, ...(r() < 0.3 ? { namespace: "default" } : {}) });
      } catch (e) {
        assert.ok(e instanceof ValidationError, `seed ${seed} query ${JSON.stringify(q)} threw ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
      }
      for (const h of hits) assert.ok(live.has(h.note.id), `seed ${seed} query ${JSON.stringify(q)} returned a note that is not live: ${h.note.id}`);
    }
  }
  // decoration around an exact word must not hide the note, and column filters must not widen or error
  for (const q of ['"tkfind"', "tkfind*", "(tkfind)", "tkfind,", "'tkfind'"]) {
    assert.ok(s.search(q).some((n) => n.id === note.id), `decorated exact word ${JSON.stringify(q)} no longer finds the note`);
  }
  s.close();
});

// ---------- 3. importers ----------
const mutate = (r: () => number, buf: Buffer): Buffer => {
  const b = Buffer.from(buf);
  const k = 1 + Math.floor(r() * 6);
  let out = b;
  for (let i = 0; i < k; i++) {
    const m = r();
    if (m < 0.4 && out.length) out[Math.floor(r() * out.length)] = Math.floor(r() * 256);
    else if (m < 0.6) out = out.subarray(0, Math.floor(r() * out.length));
    else if (m < 0.8 && out.length) { const at = Math.floor(r() * out.length); out = Buffer.concat([out.subarray(0, at), out.subarray(at, at + Math.floor(r() * 40)), out.subarray(at)]); }
    else out = Buffer.concat([out, Buffer.from(pick(r, ['"', "}", "null", "[", "\\u", "\ud800", "{}", "\n\n"]))]);
  }
  return out;
};
const plainError = (e: unknown, ctx: string): void => {
  assert.ok(e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError), `${ctx}: threw ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
};
const itemsOk = (items: unknown, ctx: string): void => {
  assert.ok(Array.isArray(items), ctx);
  for (const it of items as Array<Record<string, unknown>>) {
    assert.equal(typeof it.id, "string", `${ctx}: id`);
    assert.equal(typeof it.title, "string", `${ctx}: title`);
    assert.equal(typeof it.body, "string", `${ctx}: body`);
    assert.ok(Array.isArray(it.tags) && (it.tags as unknown[]).every((t) => typeof t === "string"), `${ctx}: tags`);
  }
};

test("importers: randomly damaged export files give items or a plain error, never a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "fuzz-imp-"));
  try {
    const readers: Array<[string, string, (p: string) => unknown]> = [
      ["engram-export.json", "engram", (p) => readEngram(p)],
      ["agentmemory-export.json", "agentmemory", (p) => readAgentMemory(p)],
      ["ai-memory-export.json", "ai-memory", (p) => readAiMemory(p)],
    ];
    for (const [file, name, read] of readers) {
      const orig = readFileSync(join(FIX, file));
      for (let seed = FIRST; seed < FIRST + N; seed++) {
        const p = join(dir, `${name}-${seed}.json`);
        writeFileSync(p, mutate(rng(seed), orig));
        try { itemsOk(read(p), `${name} seed ${seed}`); } catch (e) { plainError(e, `${name} seed ${seed}`); }
      }
    }
    const jsonl = readFileSync(join(FIX, "mcp-memory.jsonl"));
    for (let seed = FIRST; seed < FIRST + N; seed++) {
      const p = join(dir, `chat-${seed}.jsonl`);
      writeFileSync(p, mutate(rng(seed), jsonl));
      try { readChatSession(p); } catch (e) { plainError(e, `chat seed ${seed}`); }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A stored (uncompressed) zip with the given entries; names are written as given. */
function zipOf(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name), d = Buffer.from(text);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, d); central.push(ch, n);
    off += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("zip/Notion import: damaged zips never crash, and hostile entry names write nothing anywhere", () => {
  const root = mkdtempSync(join(tmpdir(), "fuzz-zip-"));
  try {
    const sandbox = join(root, "sandbox");
    mkdirSync(sandbox);
    const before = readdirSync(root).sort();
    const good = zipOf([["a/Page 0123456789abcdef0123456789abcdef.md", "# Title\nbody text"], ["../../escape.md", "# x\nescape"], ["/abs/evil.md", "# y\nabs"], ["C:\\win\\evil.md", "# z\nwin"], ["b.md", "plain"]]);
    const texts = readZipMarkdown(good, 1 << 20);
    assert.ok(texts.length >= 1);
    const zp = join(root, "export.zip");
    writeFileSync(zp, good);
    itemsOk(readNotion(zp, 1 << 20), "notion zip");
    for (let seed = FIRST; seed < FIRST + N * 2; seed++) {
      const p = join(root, `z-${seed}.zip`);
      writeFileSync(p, mutate(rng(seed), good));
      try { itemsOk(readNotion(p, 1 << 20), `zip seed ${seed}`); } catch (e) { plainError(e, `zip seed ${seed}`); }
    }
    const after = readdirSync(root).filter((f) => !f.startsWith("z-") && f !== "export.zip").sort();
    assert.deepEqual(after, before, "an import created files outside its own input");
    assert.deepEqual(readdirSync(sandbox), [], "an import wrote into the sandbox folder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 4. time phrases ----------
const TIME_WORDS = ["yesterday", "today", "last", "next", "week", "month", "year", "days", "ago", "3", "10", "0", "-1", "99999999", "monday", "jan", "january", "2026", "2026-02-30", "2026-13-01", "between", "and", "since", "before", "after", "the", "of", "in", "on", "at", "noon", "midnight", "q1", "q5", "this", "morning", "weeks", "hours", "1e9", "NaN", "Infinity", "\u0000", "日本", "last-week", "12/31/1999", "T25:61", "Z", "UTC+99"];
test("parseTimePhrase: random phrases never throw; a range has real dates and start < end", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  for (let seed = FIRST; seed < FIRST + N * 6; seed++) {
    const r = rng(seed);
    const phrase = sentence(r, TIME_WORDS, 1 + Math.floor(r() * 7));
    for (const timeZone of ["UTC", "America/Winnipeg", undefined]) {
      let out: ReturnType<typeof parseTimePhrase> = null;
      try { out = parseTimePhrase(phrase, { now, ...(timeZone ? { timeZone } : {}) }); } catch (e) { assert.fail(`seed ${seed} ${JSON.stringify(phrase)} threw ${(e as Error).constructor.name}: ${(e as Error).message}`); }
      if (out) {
        assert.ok(Number.isFinite(out.start.getTime()) && Number.isFinite(out.end.getTime()), `seed ${seed} ${JSON.stringify(phrase)}: invalid date`);
        assert.ok(out.start.getTime() < out.end.getTime(), `seed ${seed} ${JSON.stringify(phrase)}: start >= end`);
      }
    }
  }
});

// ---------- 5. CJK bigrams ----------
test("cjkBigrams: at most MAX_BIGRAMS pairs, each two characters taken from the input", () => {
  const alphabet = [..."日本語のテスト漢字한국어가나다ab c1-_.,;\u200d\u0301😀"];
  for (let seed = FIRST; seed < FIRST + N * 4; seed++) {
    const r = rng(seed);
    const q = Array.from({ length: Math.floor(r() * 80) }, () => pick(r, alphabet)).join("");
    const bg = cjkBigrams(q);
    assert.ok(bg.length <= MAX_BIGRAMS, `seed ${seed}: ${bg.length} pairs`);
    assert.equal(new Set(bg).size, bg.length, `seed ${seed}: duplicate pair`);
    for (const b of bg) {
      assert.equal([...b].length, 2, `seed ${seed}: ${JSON.stringify(b)} is not 2 characters`);
      assert.ok(q.includes(b), `seed ${seed}: ${JSON.stringify(b)} is not in ${JSON.stringify(q)}`);
    }
  }
});

// ---------- 6. conflict detection ----------
const CONFLICT_WORDS = ["the", "deploy", "target", "is", "not", "no", "never", "switched", "to", "migrated", "from", "postgres", "mysql", "port", "8080", "9090", "node", "22", "v2", "api-v3", "database", "uses", "instead", "of", "now", "renamed", "cache", "redis", "region", "us-east-1", "eu-west-2", "enabled", "disabled", "\n", "!", "ß"];
test("flagConflict: pure, deterministic, never throws, and identical texts never conflict", () => {
  for (let seed = FIRST; seed < FIRST + N * 6; seed++) {
    const r = rng(seed);
    const a = { title: sentence(r, CONFLICT_WORDS, 1 + Math.floor(r() * 4)), body: sentence(r, CONFLICT_WORDS, Math.floor(r() * 25)) };
    const b = r() < 0.5 ? { title: a.title, body: a.body } : { title: sentence(r, CONFLICT_WORDS, 1 + Math.floor(r() * 4)), body: sentence(r, CONFLICT_WORDS, Math.floor(r() * 25)) };
    const x = flagConflict(a, b), y = flagConflict(a, b);
    assert.deepEqual(x, y, `seed ${seed}: not deterministic`);
    if (x) assert.ok(["negation", "switch", "value"].includes(x.kind) && typeof x.why === "string");
    const same = flagConflict(a, { ...a });
    if (same) assert.equal(same.kind, "switch", `seed ${seed}: identical texts flagged as ${same.kind}: ${JSON.stringify(a)}`);
  }
});

// ---------- 7. dedupe / corroboration ----------
test("corroborate: no hit is dropped, labels are consistent, the lift is capped", () => {
  const s = new Store(":memory:");
  try {
    const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];
    for (let seed = FIRST; seed < FIRST + 40; seed++) {
      const r = rng(seed);
      const base = sentence(r, words, 8);
      const hits = Array.from({ length: 2 + Math.floor(r() * 6) }, (_, i) => {
        const writer = pick(r, ["", "alice", "bob", "carol", "alice"]);
        const n = s.create({ title: `t${seed}-${i}`, body: r() < 0.6 ? base : sentence(r, words, 8) + ` ${seed}-${i}` }, { writtenBy: writer || undefined });
        return { note: s.read(n.id)!, score: 1 + r() };
      });
      const { hits: out, info } = corroborate(s, hits);
      assert.equal(out.length, hits.length, `seed ${seed}: hits dropped`);
      assert.deepEqual(out.map((h) => h.note.id).sort(), hits.map((h) => h.note.id).sort());
      for (const [id, c] of info) {
        assert.ok(c.copies >= 2 && c.independent_sources >= 1 && c.independent_sources <= c.copies, `seed ${seed} note ${id}: ${JSON.stringify(c)}`);
      }
      for (const h of out) {
        const o = hits.find((x) => x.note.id === h.note.id)!;
        assert.ok(h.score >= o.score && h.score <= o.score * 1.1 + 1e-9, `seed ${seed}: lift out of bounds ${o.score} -> ${h.score}`);
      }
    }
  } finally {
    s.close();
  }
});

// ---------- 8. markdown splitting ----------
test("claude-import text helpers: no throw, chunks within the limit, no text lost", () => {
  const frag = ["# H1", "## H2", "### H3", "```", "~~~", "<!--", "-->", "@import.md", "---", "key: v", "text line", "", "", "\r", "\u0000", "#" , "#\t", "    # indented", "日本語", "x".repeat(600), "# " + "y".repeat(600)];
  for (let seed = FIRST; seed < FIRST + N * 2; seed++) {
    const r = rng(seed);
    const md = Array.from({ length: Math.floor(r() * 40) }, () => pick(r, frag)).join(r() < 0.8 ? "\n" : "\r\n");
    parseFrontmatter(md);
    const { sections } = splitSections(md, "fallback");
    for (const sec of sections) assert.ok(sec.body.length > 0 && sec.heading.length >= 0);
    const max = 50 + Math.floor(r() * 200);
    const chunks = chunkBody(md, max);
    for (const c of chunks) assert.ok(c.length <= max || chunks.length === 1, `seed ${seed}: chunk ${c.length} > ${max}`);
    const strip = (t: string): string => t.replace(/\s+/g, "");
    assert.equal(strip(chunks.join("")), strip(md), `seed ${seed}: chunking lost or invented text`);
  }
});

test("readChatSession: a line that is valid JSON but not a record (null, 5, a string, a list) is a bad line, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "fuzz-chat-"));
  try {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, ['null', '5', '"x"', '[1]', JSON.stringify({ type: "user", uuid: "u1", message: { content: "hello there" } })].join("\n"));
    const stats = { sessions: 0, tooBig: 0, badLines: 0 };
    const out = readChatSession(p, stats);
    assert.equal(out.length, 1);
    assert.equal(stats.badLines, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
