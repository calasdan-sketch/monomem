// PLAN D: observed-evidence notes. memory_save `evidence` records what the writer says it observed; reads show observed vs
// inferred; evidence belongs to one version; facts-need-evidence makes an agent's confirm of a bare fact note not count.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { noteFlags } from "../src/taint.js";
import { ensureKey } from "../src/crypto.js";
import { checkEvidenceInput, setFactsNeedEvidence } from "../src/store/evidence.js";
import { confirmWriter } from "../src/store/probation.js";

const json = (r: any): any => {
  const t: string = r.content?.[0]?.text ?? "";
  return JSON.parse(t.slice(t.indexOf("{")));
};

async function connect(s: Store, label = "agent"): Promise<Client> {
  const server = createMcpServer(s, "write", {}, { label, authed: true });
  const [c, t] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: label, version: "1" });
  await Promise.all([client.connect(c), server.connect(t)]);
  return client;
}

test("memory_save evidence: observed with the cited item, [] is inferred, none keeps the old shape", async () => {
  const s = new Store(":memory:");
  const c = await connect(s);
  try {
    const save = async (args: Record<string, unknown>) => json(await c.callTool({ name: "memory_save", arguments: args }));
    const o = (await save({ title: "port", body: "the api listens on 8080", evidence: [{ kind: "file", ref: "src/server.ts:12" }, { kind: "test", ref: "api.test.ts passes" }] })).note;
    const n = s.read(o.id)!;
    assert.equal(n.basis, "observed");
    assert.deepEqual(n.evidence, [{ kind: "file", ref: "src/server.ts:12" }, { kind: "test", ref: "api.test.ts passes" }]);
    assert.match(noteFlags(n), /\[observed: file "src\/server\.ts:12", \+1; cited by the writer, not checked\]/);
    const i = (await save({ title: "guess", body: "the cache is probably the slow part", evidence: [] })).note;
    assert.equal(s.read(i.id)!.basis, "inferred");
    assert.match(noteFlags(s.read(i.id)!), /\[inferred/);
    const p = (await save({ title: "plain", body: "no evidence given" })).note;
    const plain = s.read(p.id)!;
    assert.equal("basis" in plain || "evidence" in plain || "evidence_label" in plain, false);
    // a search reply carries the label too
    const found = json(await c.callTool({ name: "memory_search", arguments: { query: "api listens 8080" } }));
    assert.ok(JSON.stringify(found).includes("observed"), JSON.stringify(found));
    // bad input is refused with a clear message; evidence on an update is refused
    const bad = await c.callTool({ name: "memory_save", arguments: { title: "x", body: "y", evidence: [{ kind: "vibe", ref: "z" }] } });
    assert.equal(bad.isError, true);
    const upd = await c.callTool({ name: "memory_save", arguments: { id: o.id, body: "now 9090", evidence: [{ kind: "file", ref: "a.ts:1" }] } });
    assert.equal(upd.isError, true);
    assert.match(JSON.stringify(upd), /evidence applies to creating a note/);
    // the 1.5 state_write schema is unchanged: it does not take evidence
    const legacy = json(await c.callTool({ name: "state_write", arguments: { title: "legacy", body: "old tool", evidence: [{ kind: "file", ref: "a.ts:1" }] } })).note;
    assert.equal(s.read(legacy.id)!.basis, undefined);
  } finally {
    await c.close();
    s.close();
  }
});

test("evidence belongs to the version it was saved with; a hard delete removes it", () => {
  const s = new Store(":memory:");
  const n = s.create({ title: "t", body: "b" }, { evidence: [{ kind: "command", ref: "npm test (exit 0)" }] });
  assert.equal(s.read(n.id)!.basis, "observed");
  s.update(n.id, { body: "changed" });
  assert.equal(s.read(n.id)!.basis, undefined, "the changed text is not backed by the old evidence");
  s.delete(n.id);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS c FROM note_evidence").get() as { c: number }).c, 0);
  s.close();
});

test("evidence input: secrets are redacted, sizes and kinds are checked", () => {
  const [e] = checkEvidenceInput([{ kind: "output", ref: "DB_PASSWORD=hunter2abc123 ok" }])!;
  assert.ok(!e.ref.includes("hunter2abc123"), e.ref);
  assert.throws(() => checkEvidenceInput([{ kind: "file", ref: "" }]), /ref is required/);
  assert.throws(() => checkEvidenceInput("src/a.ts"), /list of/);
  assert.throws(() => checkEvidenceInput(Array.from({ length: 11 }, () => ({ kind: "url", ref: "https://x" }))), /at most 10/);
  assert.equal(checkEvidenceInput(undefined), undefined);
});

test("encrypted store: evidence is sealed at rest and reads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "om-evidence-"));
  const prev = process.env.MONOMEM_KEY_FILE;
  process.env.MONOMEM_KEY_FILE = join(dir, ".key");
  try {
    ensureKey(dir);
    const s = new Store(join(dir, "state.db"));
    const n = s.create({ title: "t", body: "b" }, { evidence: [{ kind: "url", ref: "https://internal.example/run/42" }] });
    const raw = (s.db.prepare("SELECT items FROM note_evidence WHERE note_id = ?").get(n.id) as { items: string }).items;
    assert.ok(!raw.includes("internal.example"), "sealed");
    assert.equal(s.read(n.id)!.evidence![0].ref, "https://internal.example/run/42");
    s.close();
  } finally {
    if (prev === undefined) delete process.env.MONOMEM_KEY_FILE;
    else process.env.MONOMEM_KEY_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("facts-need-evidence on: an agent's confirm of a fact note without evidence does not count; with evidence it does", () => {
  const s = new Store(":memory:");
  const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
  const bare = as("web-bot", () => s.create({ title: "pm", body: "pnpm", tags: ["fact:package_manager=pnpm"], outside: true }));
  const cited = as("web-bot", () => s.create({ title: "pm2", body: "pnpm", tags: ["fact:package_manager=pnpm"], outside: true }, { evidence: [{ kind: "file", ref: "pnpm-lock.yaml" }] }));
  as("checker", () => s.create({ title: "hi", body: "x" }));
  confirmWriter(s, "checker", "cli");
  setFactsNeedEvidence(s, true);
  const r = as("checker", () => s.confirm(bare.id, { source: "package.json" }))!;
  assert.equal(r.reason, "no_evidence");
  const ok = as("checker", () => s.confirm(cited.id, { source: "package.json" }))!;
  assert.equal(ok.counted, true, ok.message);
  // a person's confirm always counts
  setProcessWriter("cli");
  try {
    assert.equal(s.confirm(bare.id)!.counted, true);
  } finally {
    setProcessWriter("");
  }
  s.close();
});
