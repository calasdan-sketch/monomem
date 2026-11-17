// Memory receipts (which notes a session start showed, and why) and the shareable savings card.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { injectContext } from "../src/context-inject.js";
import { meterAdd, meterStats } from "../src/meter.js";
import { createMcpServer, enabledToolNames } from "../src/mcp-server-core.js";
import { receiptAdd, receiptList, receiptGet, renderCard, whyText, localTime } from "../src/receipts.js";

const noGit = { branch: "", diffFiles: [] };
const SECRET = "SECRET-TITLE-xyzzy";

function seed(): Store {
  const s = new Store(":memory:");
  s.create({ title: `${SECRET} one`, body: "SECRET-BODY-plugh one" });
  s.create({ title: "Another note", body: "SECRET-BODY-plugh two" });
  return s;
}

describe("receipts", () => {
  test("a metered session start records ids, why-tags, rank and tokens, never note text", async () => {
    const s = seed();
    await injectContext(s, { signals: noGit, sessionId: "sess-1" });
    const r = receiptGet(s, "sess-1")!;
    assert.equal(r.notes.length, 2);
    assert.deepEqual(r.notes.map((n) => n.rank), [1, 2]);
    assert.ok(r.notes.every((n) => /^\{.*\}$/.test(n.why) && n.tokens > 0));
    const raw = JSON.stringify(s.captureDb().prepare("SELECT * FROM memory_receipts").all());
    assert.ok(!raw.includes("SECRET"), "no note text or title is stored");
    s.close();
  });

  test("an unmetered session start records nothing", async () => {
    const s = seed();
    await injectContext(s, { signals: noGit });
    assert.equal(receiptList(s).length, 0);
    s.close();
  });

  test("titles are looked up live; a deleted note is marked gone, a renamed one shows the new title", async () => {
    const s = seed();
    await injectContext(s, { signals: noGit, sessionId: "sess-1" });
    const ids = receiptGet(s, "sess-1")!.notes.map((n) => n.id);
    s.delete(ids[0]);
    const r = receiptGet(s, "sess-1")!;
    const gone = r.notes.find((n) => n.id === ids[0])!;
    assert.equal(gone.state, "gone");
    assert.equal(gone.title, null);
    assert.equal(r.notes.find((n) => n.id === ids[1])!.state, "ok");
    assert.ok(r.notes.find((n) => n.id === ids[1])!.title);
    s.close();
  });

  test("list is newest first, scoped by namespace; unknown session is null", () => {
    const s = new Store(":memory:");
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    receiptAdd(s, { sessionId: "a", namespace: "n1", client: "cli", shown: [{ id: 1, why: "{1d}", tokens: 5 }] }, t0);
    receiptAdd(s, { sessionId: "b", namespace: "n2", client: "", shown: [{ id: 2, why: "{files 1d}", tokens: 7 }] }, t0 + 1000);
    assert.deepEqual(receiptList(s).map((x) => x.session_id), ["b", "a"]);
    assert.deepEqual(receiptList(s, ["n1"]).map((x) => x.session_id), ["a"]);
    assert.equal(receiptGet(s, "a", ["n2"]), null);
    assert.equal(receiptGet(s, "nope"), null);
    assert.equal(receiptList(s)[1].notes, 1);
    s.close();
  });

  test("retention: rows older than MONOMEM_ACCESS_LOG_DAYS (default 30) go on the next write", () => {
    const s = new Store(":memory:");
    const now = Date.parse("2026-03-01T00:00:00Z");
    const shown = [{ id: 1, why: "{0d}", tokens: 1 }];
    receiptAdd(s, { sessionId: "old", namespace: "", client: "", shown }, now - 40 * 86_400_000);
    receiptAdd(s, { sessionId: "mid", namespace: "", client: "", shown }, now - 20 * 86_400_000);
    receiptAdd(s, { sessionId: "new", namespace: "", client: "", shown }, now);
    assert.deepEqual(receiptList(s).map((x) => x.session_id).sort(), ["mid", "new"]);
    process.env.MONOMEM_ACCESS_LOG_DAYS = "10";
    try {
      receiptAdd(s, { sessionId: "new2", namespace: "", client: "", shown }, now);
    } finally {
      delete process.env.MONOMEM_ACCESS_LOG_DAYS;
    }
    assert.deepEqual(receiptList(s).map((x) => x.session_id).sort(), ["new", "new2"]);
    process.env.MONOMEM_ACCESS_LOG_DAYS = "0"; // off: nothing is written
    try {
      receiptAdd(s, { sessionId: "off", namespace: "", client: "", shown }, now);
    } finally {
      delete process.env.MONOMEM_ACCESS_LOG_DAYS;
    }
    assert.ok(!receiptList(s).some((x) => x.session_id === "off"));
    s.close();
  });

  test("footnote is two lines, 1 session is singular", () => {
    const svg = renderCard({ sessions: 1, injections: 1, injected_tokens: 10, saved_tokens: 0, llm_tokens: 0 });
    assert.ok(svg.includes(">session<") && !svg.includes(">sessions<"));
    assert.equal((svg.match(/<tspan x=/g) ?? []).length, 2);
    assert.ok(!/<text[^>]*>[^<]{90,}<\/text>/.test(svg), "no single long text line");
  });
});

describe("receipt wording", () => {
  test("why tags read as words and times as local time", () => {
    assert.equal(whyText("{recent 0d}"), "recent; today");
    assert.equal(whyText("{files,kw 1d}"), "files, kw; 1 day old");
    assert.equal(whyText("{12d}"), "12 days old");
    assert.equal(whyText("odd"), "odd");
    assert.match(localTime("2026-11-05T12:03:00.000Z"), /^2026-11-0[456] \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
    assert.equal(localTime("not a date"), "not a date");
  });
});

describe("memory_receipt MCP tool", () => {
  async function connect(s: Store, tools?: string[]): Promise<Client> {
    const server = createMcpServer(s, "read", tools ? { tools } : {});
    const [c, sv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(sv)]);
    return client;
  }

  test("opt-in: not in the default tool surface", () => {
    assert.ok(!enabledToolNames({})?.has("memory_usage"));
    assert.ok(enabledToolNames({ MONOMEM_TOOLS: "memory_receipt" })?.has("memory_usage"), "the 1.5 name turns on the 1.6 tool that answers for it");
  });

  test("returns the receipt behind the untrusted-data banner, or the recent list without an id", async () => {
    const s = seed();
    await injectContext(s, { signals: noGit, sessionId: "sess-1" });
    const client = await connect(s, ["memory_receipt"]);
    const one: any = await client.callTool({ name: "memory_receipt", arguments: { session_id: "sess-1" } });
    assert.match(one.content[0].text, /UNTRUSTED DATA/);
    assert.match(one.content[0].text, new RegExp(SECRET));
    const list: any = await client.callTool({ name: "memory_receipt", arguments: {} });
    assert.match(list.content[0].text, /sess-1/);
    const none: any = await client.callTool({ name: "memory_receipt", arguments: { session_id: "nope" } });
    assert.equal(none.isError, true);
    await client.close();
    s.close();
  });
});

describe("savings card", () => {
  test("shows the meter's real numbers, the estimate label and the no-network line; escapes text", () => {
    const s = new Store(":memory:");
    meterAdd(s, "s1", "", { injected: 1200, saved: 3400 });
    meterAdd(s, "s2", "", { injected: 300, saved: 100 });
    const svg = renderCard(meterStats(s).totals);
    assert.match(svg, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.includes("#0B2E45") && svg.includes("#F0C171"));
    assert.ok(svg.includes(">2<"), "sessions");
    assert.ok(svg.includes(">1,500<"), "tokens injected");
    assert.ok(svg.includes(">3,500<"), "tokens saved");
    assert.ok(svg.includes("estimate, ~4 chars/token"));
    assert.ok(svg.includes("No network calls by Monomem by default"));
    assert.ok(!svg.includes("0 bytes"), "no unprovable byte claim");
    // escaping: a hostile number-ish value cannot break out
    const evil = renderCard({ sessions: "<script>" as never, injections: 0, injected_tokens: 0, saved_tokens: 0, llm_tokens: 0 });
    assert.ok(!evil.includes("<script>") && evil.includes("&lt;script&gt;"));
    s.close();
  });
});
