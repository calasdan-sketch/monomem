import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
// R2-06: accepted, held and refused note writes answer with a receipt {seq, chain_hash, decision} from the audit chain, on
// MCP state_write and REST POST/PUT /notes alike; `monomem verify-receipt <seq> <hash>` finds it in the unbroken chain and
// names the line when the chain was tampered with.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { verifyAuditChain } from "../src/security.js";
import { PROJECT_ROOT } from "../src/config.js";

const CLI = join(PROJECT_ROOT, "dist", "src", "cli.js");
const SECRET = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const TOKEN = "receipt-writer".padEnd(32, "x");
type Receipt = { seq: number; chain_hash: string; decision: string };

let dir = "";
let log = "";
let saved: string | undefined;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "om-r206-"));
  log = join(dir, "audit.log");
  saved = process.env.MONOMEM_AUDIT_LOG;
  process.env.MONOMEM_AUDIT_LOG = log;
});
after(() => {
  if (saved === undefined) delete process.env.MONOMEM_AUDIT_LOG;
  else process.env.MONOMEM_AUDIT_LOG = saved;
  rmSync(dir, { recursive: true, force: true });
});

function inChain(r: Receipt | undefined, decision: string): void {
  assert.ok(r, "a receipt is returned");
  assert.equal(r.decision, decision);
  assert.match(r.chain_hash, /^[0-9a-f]{64}$/);
  const v = verifyAuditChain(log, r.chain_hash);
  assert.equal(v.ok, true);
  assert.equal(v.anchor?.found, true);
  assert.equal(v.anchor?.seq, r.seq);
}

async function world() {
  const store = new Store(":memory:");
  store.setApproveFirst("held", true);
  const server = createApiServer(store, [{ token: TOKEN, scope: "write", label: "rest-writer" }]);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rest = async (method: string, path: string, body: object) => {
    const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const mcpServer = createMcpServer(store, "write", {}, { label: "mcp-writer", authed: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "r206", version: "1" });
  await Promise.all([client.connect(a), mcpServer.connect(b)]);
  const mcp = async (args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: "state_write", arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const t = r.content[0].text;
    return { isError: !!r.isError, json: JSON.parse(t.slice(t.indexOf("{"))) as Record<string, unknown> };
  };
  const close = async () => {
    await client.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  };
  return { mcp, rest, close };
}

describe("R2-06 write receipts", () => {
  test("MCP state_write: accepted (create and update), held, refused", async () => {
    const w = await world();
    try {
      const made = await w.mcp({ title: "receipt note", body: "plain text" });
      inChain(made.json.receipt as Receipt, "accepted");
      const id = (made.json.note as { id: number }).id;
      const upd = await w.mcp({ id, body: "changed text" });
      inChain(upd.json.receipt as Receipt, "accepted");
      assert.ok((upd.json.receipt as Receipt).seq > (made.json.receipt as Receipt).seq);
      const held = await w.mcp({ namespace: "held", title: "needs approval", body: "x" });
      assert.ok(held.json.quarantined);
      inChain(held.json.receipt as Receipt, "held");
      const refused = await w.mcp({ title: "leak", body: `token ${SECRET}` });
      assert.equal(refused.isError, true);
      inChain(refused.json.receipt as Receipt, "refused");
      // The refusal line names the error class, never the note text.
      assert.ok(!readFileSync(log, "utf8").includes(SECRET));
    } finally {
      await w.close();
    }
  });

  test("REST POST/PUT /notes: accepted (201, 200), held (202), refused (400)", async () => {
    const w = await world();
    try {
      const made = await w.rest("POST", "/notes", { title: "rest receipt", body: "plain" });
      assert.equal(made.status, 201);
      inChain(made.json.receipt as Receipt, "accepted");
      const id = (made.json.note as { id: number }).id;
      const upd = await w.rest("PUT", `/notes/${id}`, { body: "changed" });
      assert.equal(upd.status, 200);
      inChain(upd.json.receipt as Receipt, "accepted");
      const held = await w.rest("POST", "/notes", { namespace: "held", title: "needs approval", body: "x" });
      assert.equal(held.status, 202);
      inChain(held.json.receipt as Receipt, "held");
      const refused = await w.rest("POST", "/notes", { title: "leak", body: `token ${SECRET}` });
      assert.equal(refused.status, 400);
      inChain(refused.json.receipt as Receipt, "refused");
    } finally {
      await w.close();
    }
  });

  test("an unchanged update writes nothing and carries no receipt", async () => {
    const w = await world();
    try {
      const made = await w.mcp({ title: "same", body: "same" });
      const id = (made.json.note as { id: number }).id;
      const again = await w.mcp({ id, body: "same" });
      assert.equal(again.json.unchanged, true);
      assert.equal(again.json.receipt, undefined);
    } finally {
      await w.close();
    }
  });

  test("monomem verify-receipt: OK on an intact chain; a tampered earlier line fails naming that line; a wrong seq fails", async () => {
    const w = await world();
    let r: Receipt;
    try {
      await w.mcp({ title: "first", body: "a" });
      await w.mcp({ title: "second", body: "b" });
      r = (await w.mcp({ title: "third", body: "c" })).json.receipt as Receipt;
    } finally {
      await w.close();
    }
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, "verify-receipt", ...args], { encoding: "utf8", env: { ...process.env, MONOMEM_AUDIT_LOG: log } });
    const ok = cli(String(r.seq), r.chain_hash);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Receipt OK/);
    const badSeq = cli(String(r.seq + 1000), r.chain_hash);
    assert.equal(badSeq.status, 1);
    assert.match(badSeq.stderr, /seq/);
    assert.equal(cli("x", "y").status, 2);
    // Tamper with the line just before the receipt's: the line after it no longer follows.
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
    const at = lines.findIndex((l) => JSON.parse(l).seq === r.seq);
    assert.ok(at >= 2);
    lines[at - 2] = lines[at - 2].replace(/"op":"[^"]+"/, '"op":"forged"');
    writeFileSync(log, lines.join("\n") + "\n");
    const broken = cli(String(r.seq), r.chain_hash);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, new RegExp(`line ${at} of `)); // 1-based: the line after the edited one is the break
  });
});
