// r2-innovation #1: a note that restates a note the same session was shown is an echo: labelled, linked, same status, no second source.
import "./setup-env.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { receiptAdd } from "../src/receipts.js";

const json = (r: any): any => {
  const t: string = r.content?.[0]?.text ?? "";
  return JSON.parse(t.slice(t.indexOf("{")));
};
afterEach(() => setProcessWriter(""));

const PAGE = "Acme raised the price of the pro plan to forty dollars per seat per month starting in January";
const PARAPHRASE = "Note: the Acme pro plan price rises to forty dollars per seat per month, starting January";

test("an agent that read an unconfirmed note and restates it writes an echo: unconfirmed, labelled, linked, cannot confirm the original", async () => {
  const s = new Store(":memory:");
  const web = actorStore.run({ label: "web-bot", authed: true }, () => s.create({ title: "acme pricing", body: PAGE, outside: true }));
  assert.equal(web.unconfirmed, true);
  const server = createMcpServer(s, "write", {}, { label: "agent", authed: true });
  const [c, t] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "1" });
  await Promise.all([client.connect(c), server.connect(t)]);
  try {
    await client.callTool({ name: "state_read", arguments: { id: web.id } });
    const w = json(await client.callTool({ name: "state_write", arguments: { title: "acme price change", body: PARAPHRASE } })).note;
    const n = s.read(w.id)!;
    assert.equal(n.echo_of, web.id);
    assert.match(n.echo_label ?? "", new RegExp(`echo of #${web.id}`));
    assert.equal(n.unconfirmed, true, "keeps the original's unconfirmed status");
    assert.deepEqual(n.derived_from, [web.id]);
    // not an independent source: its writer cannot confirm the original
    const r = actorStore.run({ label: "agent", authed: true }, () => s.confirm(web.id, { source: "https://acme.example/pricing" }))!;
    assert.equal(r.counted, false);
    // an unrelated note is not an echo
    const other = json(await client.callTool({ name: "state_write", arguments: { title: "test runner", body: "this project runs its tests with node --test and a small setup file" } })).note;
    assert.equal(s.read(other.id)!.echo_of, undefined);
  } finally {
    await client.close();
    s.close();
  }
});

test("a local writer restating a note its session start showed (memory_receipts) writes an echo", () => {
  const s = new Store(":memory:");
  try {
    const orig = actorStore.run({ label: "claude-code", authed: true }, () => s.create({ title: "acme pricing", body: PAGE }));
    const now = new Date().toISOString();
    s.db.prepare("INSERT INTO sessions (id, namespace, cwd, started_at) VALUES (?, ?, ?, ?)").run("sess-1", "default", "/work/proj", now);
    receiptAdd(s, { sessionId: "sess-1", namespace: "default", client: "stdio", shown: [{ id: orig.id, why: "decision", tokens: 20 }] });
    setProcessWriter("stdio");
    const echo = actorStore.run({ label: "", authed: false, cwd: "/work/proj" }, () => s.create({ title: "acme price", body: PARAPHRASE }));
    assert.equal(echo.echo_of, orig.id);
    const elsewhere = actorStore.run({ label: "", authed: false, cwd: "/other/proj" }, () => s.create({ title: "acme price", body: PARAPHRASE }));
    assert.equal(elsewhere.echo_of, undefined, "another folder's session start is not this writer's");
  } finally {
    s.close();
  }
});

test("facts: an echo does not make two writers agree", async () => {
  const { factsTable } = await import("../src/facts.js");
  const s = new Store(":memory:");
  try {
    // Two established writers (notes from before 1.6), so writer probation (test/probation.test.ts) is not what decides here.
    for (const w of ["claude-code", "codex"]) s.create({ title: "earlier", body: "before the upgrade" }, { writtenBy: w });
    const a = actorStore.run({ label: "claude-code", authed: true }, () => s.create({ title: "deploy", body: "x", tags: ["fact:deploy_target=fly.io"] }));
    const b = actorStore.run({ label: "codex", authed: true }, () => s.create({ title: "deploy", body: "y", tags: ["fact:deploy_target=fly.io"] }));
    assert.equal(factsTable([s.read(a.id)!, s.read(b.id)!]).default[0].agreed, true);
    const echo = { ...s.read(b.id)!, echo_of: a.id };
    assert.equal(factsTable([s.read(a.id)!, echo]).default[0].agreed, false);
  } finally {
    s.close();
  }
});
