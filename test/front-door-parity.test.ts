// P-01 (1.5.0 round 2, ARCH A4.1/A4.3): REST and MCP make the same trust decision for the same request. Two rules used to be
// written once per surface: the include_distrusted opt-in (admin only, a pinned admin only for its own namespace, by-id reads
// checked where the note is read) and the update path (visibility, namespace, reserved and reviewed tags, facts). Both now go
// through one function (distrustedOptInRefusal in trust.ts, prepareNoteUpdate in note-update.ts); this table runs each
// scenario through PUT /notes/:id or a GET route and through MCP state_write / a read tool, and compares the decisions.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import type { Scope } from "../src/config.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);

type Who = "writer" | "admin" | "pinned-writer" | "pinned-admin";
const SCOPE: Record<Who, Scope> = { writer: "write", admin: "admin", "pinned-writer": "write", "pinned-admin": "admin" };
const PINNED: Record<Who, boolean> = { writer: false, admin: false, "pinned-writer": true, "pinned-admin": true };
const NS_OPTS = { readsFrom: { work: ["shared"] } };

interface World {
  s: Store;
  ids: { work: number; workTagged: number; hidden: number; hiddenTask: number; archived: number; shared: number};
}

function seed(): World {
  const s = new Store(":memory:");
  const work = as("good", () => s.create({ namespace: "work", title: "plain work", body: "zebra" })).id;
  const workTagged = as("good", () => s.create({ namespace: "work", title: "tagged", body: "zebra", tags: ["keep"] })).id;
  const hidden = as("evil", () => s.create({ namespace: "work", title: "EVILNOTE", body: "zebra" })).id;
  const hiddenTask = as("evil", () => s.create({ namespace: "work", title: "EVILTASK", body: "zebra", tags: ["topic"] })).id;
  const archived = as("good", () => s.create({ namespace: "work", title: "old", body: "zebra" })).id;
  s.archive(archived);
  const shared = as("good", () => s.create({ namespace: "shared", title: "shared note", body: "zebra" })).id;
  s.distrustAdd("work", "evil");
  return { s, ids: { work, workTagged, hidden, hiddenTask, archived, shared } };
}

/** One REST server with a token per caller kind, and one MCP client per caller kind (same store). */
async function surfaces(w: World) {
  const tok = (who: Who) => `${who.replace(/-/g, "")}`.padEnd(32, "x");
  // Two REST servers, as two deployments: an unpinned one, and one pinned to "work" that may read "shared" (the same
  // namespace options the MCP server gets for a pinned caller).
  const servers = new Map<boolean, { server: ReturnType<typeof createApiServer>; base: string }>();
  for (const pinned of [false, true]) {
    const who = (Object.keys(SCOPE) as Who[]).filter((k) => PINNED[k] === pinned);
    const server = createApiServer(
      w.s,
      who.map((k) => ({ token: tok(k), scope: SCOPE[k], label: k })),
      pinned ? { namespace: "work", ...NS_OPTS } : {},
    );
    await new Promise<void>((r) => server.listen(0, r));
    servers.set(pinned, { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  }
  const clients = new Map<Who, Client>();
  for (const who of Object.keys(SCOPE) as Who[]) {
    const mcp = createMcpServer(w.s, SCOPE[who], PINNED[who] ? { namespace: "work", ...NS_OPTS, tools: "all" } : { tools: "all" }, { label: who, authed: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "parity", version: "1" });
    await Promise.all([c.connect(a), mcp.connect(b)]);
    clients.set(who, c);
  }
  const rest = async (who: Who, method: string, path: string, body?: object): Promise<{ ok: boolean; text: string }> => {
    const r = await fetch(servers.get(PINNED[who])!.base + path, {
      method,
      headers: { Authorization: `Bearer ${tok(who)}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { ok: r.ok, text: await r.text() };
  };
  const mcp = async (who: Who, name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> => {
    const r = (await clients.get(who)!.callTool({ name, arguments: args })) as { isError?: boolean };
    return { ok: !r.isError, text: JSON.stringify(r) };
  };
  const close = async () => {
    for (const c of clients.values()) await c.close();
    for (const { server } of servers.values()) await new Promise<void>((r) => server.close(() => r()));
    w.s.close();
  };
  return { rest, mcp, close };
}

describe("P-01: REST and MCP decide an update the same way", () => {
  // [caller, note key, patch (tags / facts), expected decision, text that must not appear in either reply]
  type Row = [Who, keyof World["ids"] | "missing", { tags?: string[]; facts?: Record<string, string> }, boolean, string];
  const rows: Row[] = [
    ["writer", "work", { tags: ["a"] }, true, ""],
    ["writer", "work", { facts: { deploy_target: "render" } }, true, ""],
    ["writer", "work", { tags: ["a"], facts: { deploy_target: "render" } }, true, ""],
    ["writer", "workTagged", { tags: ["keep", "handoff"] }, false, ""], // a reserved tag belongs to session_handoff / task_put
    ["writer", "work", { tags: ["reviewed"] }, false, ""], // only an admin accepting a note in the dashboard sets it
    // A raw fact: tag with a line break is refused even when `facts` would replace it (REST used to check only the merged tags).
    ["writer", "work", { tags: ["fact:x=a\nb"], facts: { deploy_target: "render" } }, false, ""],
    ["writer", "hidden", { tags: ["x"] }, false, "EVILNOTE"], // hidden by the distrust list: reads as missing
    ["writer", "hiddenTask", { tags: ["handoff"] }, false, "EVILTASK"], // A2: the tag guard must not reveal a hidden note
    ["writer", "archived", { tags: ["x"] }, false, ""], // a forgotten note is restored first, never edited
    ["writer", "missing", { tags: ["x"] }, false, ""],
    ["admin", "hidden", { tags: ["x"] }, true, ""], // an admin may rewrite a hidden note under a trusted writer
    ["pinned-writer", "work", { tags: ["a"] }, true, ""],
    ["pinned-writer", "shared", { tags: ["a"] }, false, "shared note"], // a read grant never confers write access
    ["pinned-admin", "shared", { tags: ["a"] }, false, "shared note"],
  ];

  test("the table, through PUT /notes/:id and state_write", async () => {
    for (const [who, key, patch, want, secret] of rows) {
      const w = seed();
      const id = key === "missing" ? 9999 : w.ids[key];
      const io = await surfaces(w);
      try {
        const r = await io.rest(who, "PUT", `/notes/${id}`, patch);
        const m = await io.mcp(who, "state_write", { id, ...patch });
        const label = `${who} ${key} ${JSON.stringify(patch)}`;
        assert.equal(r.ok, want, `REST ${label}: ${r.text.slice(0, 200)}`);
        assert.equal(m.ok, want, `MCP ${label}: ${m.text.slice(0, 200)}`);
        if (secret) for (const t of [r.text, m.text]) assert.ok(!t.includes(secret), `${label} leaked ${secret}: ${t.slice(0, 200)}`);
        if (key === "hiddenTask" || key === "hidden") {
          assert.ok(!/reserved/.test(r.text) && !/reserved/.test(m.text), `${label}: a hidden note must read as missing, not as a tag refusal`);
        }
      } finally {
        await io.close();
      }
    }
  });

  test("documented difference: the reviewed tag is the REST admin's (the dashboard), never an MCP admin agent's", async () => {
    const w = seed();
    const io = await surfaces(w);
    try {
      assert.equal((await io.mcp("admin", "state_write", { id: w.ids.work, tags: ["reviewed"] })).ok, false);
      assert.equal((await io.rest("admin", "PUT", `/notes/${w.ids.work}`, { tags: ["reviewed"] })).ok, true);
    } finally {
      await io.close();
    }
  });
});

describe("P-01: REST and MCP refuse include_distrusted the same way", () => {
  // [caller, namespace named (null = none), by id?, expected decision]
  type Row = [Who, string | null, boolean, boolean];
  const rows: Row[] = [
    ["writer", "work", false, false], // not an admin
    ["writer", null, true, false],
    ["admin", "work", false, true],
    ["admin", null, true, true],
    ["pinned-admin", "work", false, true], // its own namespace
    ["pinned-admin", "shared", false, false], // a namespace it only reads: governed by that namespace's admin
    ["pinned-admin", null, false, false], // must say which namespace
    ["pinned-admin", null, true, true], // by id: checked against the note's own namespace where it is read
  ];

  test("the table, through GET /notes or /notes/:id and state_list or state_read", async () => {
    for (const [who, ns, byId, want] of rows) {
      const w = seed();
      const io = await surfaces(w);
      try {
        const label = `${who} ns=${ns} byId=${byId}`;
        const r = byId
          ? await io.rest(who, "GET", `/notes/${w.ids.hidden}?include_distrusted=1`)
          : await io.rest(who, "GET", `/notes?include_distrusted=1${ns ? `&namespace=${ns}` : ""}`);
        const m = byId
          ? await io.mcp(who, "state_read", { id: w.ids.hidden, include_distrusted: true })
          : await io.mcp(who, "state_list", { include_distrusted: true, ...(ns ? { namespace: ns } : {}) });
        assert.equal(r.ok, want, `REST ${label}: ${r.text.slice(0, 200)}`);
        assert.equal(m.ok, want, `MCP ${label}: ${m.text.slice(0, 200)}`);
      } finally {
        await io.close();
      }
    }
  });
});

describe("R2-06: REST and MCP give the same write receipt decision", () => {
  // [caller, patch, approve-first on "work"?, expected receipt decision]
  type Row = [Who, { body: string }, boolean, "accepted" | "held" | "refused"];
  const rows: Row[] = [
    ["writer", { body: "a new body" }, false, "accepted"],
    ["writer", { body: "a new body" }, true, "held"], // approve-first: held for a person
    ["writer", { body: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" }, false, "refused"], // looks like a GitHub token
  ];
  const receiptOf = (text: string, mcp: boolean): { decision?: string; chain_hash?: string } | undefined => {
    const j = JSON.parse(text);
    if (!mcp) return j.receipt;
    const t = j.content[0].text as string;
    return JSON.parse(t.slice(t.indexOf("{"))).receipt;
  };

  test("the table, through PUT /notes/:id and state_write", async () => {
    const save = process.env.MONOMEM_AUDIT_LOG;
    const dir = mkdtempSync(join(tmpdir(), "om-parity-r206-"));
    process.env.MONOMEM_AUDIT_LOG = join(dir, "audit.log"); // an in-memory store audits only with an explicit log
    try {
      for (const [who, patch, approveFirst, want] of rows) {
        const w = seed();
        if (approveFirst) w.s.setApproveFirst("work", true);
        const io = await surfaces(w);
        try {
          const label = `${who} ${want}`;
          const r = receiptOf((await io.rest(who, "PUT", `/notes/${w.ids.work}`, patch)).text, false);
          const m = receiptOf((await io.mcp(who, "state_write", { id: w.ids.work, body: patch.body + " (mcp)" })).text, true); // not the same text: that would be unchanged
          assert.equal(r?.decision, want, `REST ${label}`);
          assert.equal(m?.decision, want, `MCP ${label}`);
          assert.notEqual(r?.chain_hash, m?.chain_hash, `${label}: two writes, two lines`);
        } finally {
          await io.close();
        }
      }
    } finally {
      if (save === undefined) delete process.env.MONOMEM_AUDIT_LOG;
      else process.env.MONOMEM_AUDIT_LOG = save;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
