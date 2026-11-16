// 1.5.0 R1-05 guard: every REST route and every MCP tool is either probed (a reply that carries an unconfirmed note must mark the
// reader: its next write is via:memory) or listed as exempt with a reason. A new route or tool fails here until it is classified,
// so it cannot silently skip read-taint.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { setProcessWriter } from "../src/actor.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const VIA = "obs.origin:via:memory";
const body = (r: any): string => r.content?.[0]?.text ?? "";
const json = (r: any): any => {
  const t = body(r);
  return JSON.parse(t.slice(t.indexOf("{")));
};
afterEach(() => setProcessWriter(""));

// ---------- REST ----------
type RestProbe = (call: (method: string, path: string, b?: unknown) => Promise<{ status: number; text: string }>, n: number, t: number) => Promise<{ status: number; text: string }>;
const REST_PROBES: Record<string, RestProbe> = {
  "GET /notes": (c) => c("GET", "/notes"),
  "GET /notes/:id": (c, n) => c("GET", `/notes/${n}`),
  "PUT /notes/:id": (c, n) => c("PUT", `/notes/${n}`, { confidence: 0.5 }),
  "GET /search": (c) => c("GET", "/search?q=vendor"),
  "POST /relevant": (c) => c("POST", "/relevant", { message: "vendor page" }),
  "GET /index": (c) => c("GET", "/index"),
  "GET /timeline": (c, n) => c("GET", `/timeline?anchor=${n}`),
  "POST /get": (c, n) => c("POST", "/get", { ids: [n] }),
  "GET /tasks": (c) => c("GET", "/tasks"),
  "GET /tasks/:id": (c, _n, t) => c("GET", `/tasks/${t}`),
  "PUT /tasks/:id": (c, _n, t) => c("PUT", `/tasks/${t}`, { owner: "B2" }),
  "GET /catch-up": (c) => c("GET", "/catch-up?consumer=zz"),
};
/** Routes with no probe, each with the reason it cannot hand a token an unconfirmed note it did not write itself. */
const REST_EXEMPT: Record<string, string> = {
  "POST /tasks/:id/claim": "A1: refuses a task that needs a person (unconfirmed outside content) and returns none of it; a claimable task is never unconfirmed (test/taint-reply-register.test.ts)",
  "GET /changes": "titles and ids only; the payload has no unconfirmed flag, so nothing registers (MCP memory_since probes the ids itself). Known gap, not a content leak",
  "GET /notes/:id/history": "admin only",
  "GET /health": "no note content",
  "GET /proof": "returns an HMAC of a nonce, no note content",
  "GET /status": "admin; build and body-index counters, no note content",
  "GET /ready": "no note content",
  "GET /": "dashboard page",
  "GET /favicon.ico": "static",
  "GET /dashboard.js": "static",
  "POST /login": "no note content",
  "GET (sign pages)": "static pages",
  "GET /whoami": "no note content",
  "GET /tokens": "no note content",
  "POST /tokens": "admin: key management",
  "DELETE /tokens/:label": "admin: key management",
  "POST /notes": "creating route: the note in the reply is the caller's own",
  "POST /notes/:id/flag": "reply is the flag verdict (id, rev), no note text",
  "POST /tasks": "creating route: the task in the reply is the caller's own",
  "POST /handoffs": "creating route: the handoff in the reply is the caller's own",
  "POST /notes/:id/confirm": "reply is the confirm verdict; the read_it rule reads the registry directly",
  "DELETE /notes/:id": "admin delete, replies {deleted}",
  "POST /notes/:id/archive": "replies the id and state only",
  "POST /notes/:id/restore": "replies the id and state only",
  "POST /notes/:id/history": "admin/restore-version, covered by the generic reply hook (see api.ts) and the PUT probe",
  "DELETE /notes/:id/history": "admin purge, replies counts",
  "POST /sweep-expired": "admin",
  "GET /insights": "admin report",
  "GET /audit": "admin report",
  "GET /quality": "admin report",
  "GET /access": "admin; labels and previews, no note text",
  "POST /flood/resume": "admin",
  "POST /rollback": "admin",
  "GET /quarantine": "admin",
  "GET /quarantine/:id/context": "admin",
  "POST /quarantine/:id": "admin",
  "GET /stats": "counts only",
  "GET /sessions": "session rows, no note text",
  "GET /files/timeline": "file paths and session ids",
  "GET /sessions/:id": "session row",
  "POST /capture": "ingest, replies counts",
  "POST /rebuild-edges": "admin",
  "POST /ack": "replies cursor state",
  "GET /handoffs": "handoffs are created by the same writer path; probed via /tasks and /notes (same serializer)",
  "GET /runner/status": "no note content",
  "GET /export": "admin backup",
  "POST /import": "admin",
  "GET /trust": "no note content",
  // routes-ui.ts: every /ui/ route needs the main (admin) key with no pin and no limit.
  "GET /ui/state": "main key only; settings and version, no note content",
  "GET /ui/needs-you": "main key only; counts and plain sentences, no note content",
  "GET /ui/review": "main key only (like monomem review); ids and titles, no unconfirmed flag in the payload",
  "POST /ui/review/:id/keep": "main key plus a person session; replies counts",
  "PUT /ui/settings": "main key plus a local sign-in; replies settings",
  "GET /ui/apps": "main key plus a local sign-in; app names, no note content",
  "POST /ui/apps/connect": "main key plus a local sign-in; replies command output",
  "POST /ui/update": "main key plus a local sign-in; replies command output",
  "POST /ui/remove": "main key plus a local sign-in; replies command output",
  "POST /ui/service": "main key plus a local sign-in; replies command output",
  "POST /ui/backup": "main key plus a local sign-in; replies the backup folder",
  "GET /ui/sync": "main key plus a local sign-in; sync kind, folder or scrubbed address, no note content",
  "POST /ui/sync/setup": "main key plus a local sign-in; replies command output",
};

function restRoutesInSource(): string[] {
  // api.ts and the route files split out of it (src/api/).
  const api = [join(SRC, "api.ts"), ...readdirSync(join(SRC, "api")).filter((f) => f.endsWith(".ts")).sort().map((f) => join(SRC, "api", f))]
    .map((p) => readFileSync(p, "utf8"))
    .join("\n");
  const found = new Set<string>();
  const named: Record<string, string> = {
    idMatch: "/notes/:id",
    getId: "/tasks/:id",
    tid: "/tasks/:id",
    sub: "/tasks/:id/claim",
    confirmMatch: "/notes/:id/confirm",
    flagMatch: "/notes/:id/flag",
    archMatch: "/notes/:id/archive",
    restoreMatch: "/notes/:id/restore",
    histMatch: "/notes/:id/history",
    sessMatch: "/sessions/:id",
    qCtxMatch: "/quarantine/:id/context",
    qMatch: "/quarantine/:id",
    del: "/tokens/:label",
    keep: "/ui/review/:id/keep",
  };
  for (const m of api.matchAll(/req\.method === "([A-Z]+)" && (?:\(?path === "([^"]+)"|\(?(\w+)|\/\^)/g)) {
    const [, method, lit, v] = m;
    if (lit) found.add(`${method} ${lit}`);
    else if (v === "SIGN_PAGES") found.add(`${method} (sign pages)`);
    else if (v === "path") continue;
    else if (v && named[v]) found.add(`${method} ${named[v]}`);
    else found.add(`${method} ?${v ?? "regex"}`);
  }
  // alternation forms: `(path === "/" || path === "/ui" ...)`, `(path === "/access" || path === "/flood")`, rollback preview/confirm
  found.delete("GET ?regex");
  return [...found];
}

describe("R1-05 guard: every REST route registers read-taint or is exempt", () => {
  test("every route in api.ts is classified", () => {
    const known = new Set([...Object.keys(REST_PROBES), ...Object.keys(REST_EXEMPT)]);
    const unknown = restRoutesInSource().filter((r) => !known.has(r) && !["GET /flood", "GET /ui", "POST /rollback/preview", "POST /rollback/confirm", "GET ?regex", "POST ?regex", "GET /tasks/:id/claim"].includes(r));
    assert.deepEqual(unknown, [], "a REST route was added: add a probe to REST_PROBES (it returns notes/tasks) or REST_EXEMPT with the reason it cannot carry an unconfirmed note");
  });

  for (const [route, probe] of Object.entries(REST_PROBES)) {
    test(`${route}: a reply with an unconfirmed note marks the token (next write is via:memory)`, async () => {
      const store = new Store(":memory:");
      setProcessWriter("server");
      const A = { token: "a".repeat(40), scope: "write" as const, label: "browser-bot", reads_outside: true };
      const B = { token: "b".repeat(40), scope: "write" as const, label: "worker-bot" };
      const http = createApiServer(store, [A, B]);
      await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
      const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
      const call = async (tok: string, method: string, path: string, b?: unknown) => {
        const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
        return { status: r.status, text: await r.text() };
      };
      try {
        const n = JSON.parse((await call(A.token, "POST", "/notes", { title: "vendor page", body: "SECRET-PAYLOAD" })).text).note;
        const t = JSON.parse((await call(A.token, "POST", "/tasks", { title: "deploy vendor page", notes: "SECRET-PAYLOAD-TASK", next_step: "x" })).text).task;
        const r = await probe((m, p, b) => call(B.token, m, p, b), n.id, t.id);
        assert.ok(r.status >= 200 && r.status < 300, `${route} -> ${r.status} ${r.text.slice(0, 200)}`);
        assert.match(r.text, /"unconfirmed":true/, `${route}: the probe must actually return an unconfirmed note (else this test proves nothing): ${r.text.slice(0, 200)}`);
        const w = JSON.parse((await call(B.token, "POST", "/notes", { title: "copy", body: "x" })).text).note;
        assert.ok(w.tags.includes(VIA), `${route}: next write is marked: ${w.tags.join()}`);
      } finally {
        http.closeAllConnections();
        await new Promise<void>((r) => http.close(() => r()));
        store.close();
      }
    });
  }
});

// ---------- MCP ----------
const MCP_PROBES: Record<string, (n: number, t: number) => Record<string, unknown>> = {
  state_read: (n) => ({ id: n }),
  state_search: () => ({ query: "vendor" }),
  state_relevant: () => ({ message: "vendor page" }),
  state_list: () => ({}),
  memory_get: (n) => ({ ids: [n] }),
  memory_index: () => ({}),
  memory_timeline: (n) => ({ anchor: n }),
  memory_history: (n) => ({ id: n }),
  memory_since: () => ({ since: "1h" }),
  catch_up: () => ({ consumer: "zz" }),
  task_get: (_n, t) => ({ id: t }),
  task_list: () => ({}),
  task_put: (_n, t) => ({ id: t, owner: "me2" }),
};
/** Replies that carry ids and titles but no unconfirmed flag; the connection marks them by probing the ids (ID_PROBE_TOOLS). */
const FLAGLESS = new Set(["memory_history", "memory_since"]);
/** Tools that are probed through a different tool's serializer, or that need an admin/other setup. Reason required. */
const MCP_EXEMPT: Record<string, string> = {
  state_write: "creating tool (own note); the edit-by-id form is probed in test/taint-reply-register.test.ts",
  state_delete: "admin, replies the id",
  memory_stats: "counts only",
  memory_receipt: "titles of the caller's own writes",
  memory_why: "admin/opt-in, titles only",
  memory_consolidation_candidates: "admin",
  memory_consolidate: "admin",
  memory_rebuild_edges: "admin",
  memory_ack: "cursor state",
  session_handoff: "creating tool (own handoff)",
  session_list: "session rows, no note text",
  task_approve: "admin",
  task_claim: "A1: refuses a task that needs a person (unconfirmed outside content) and returns none of it; a claimable task is never unconfirmed (test/taint-reply-register.test.ts)",
  memory_quarantine: "admin",
  runner_status: "no note content",
  trust_policy: "no note content",
  memory_supersede_preview: "admin",
  memory_supersede_confirm: "admin",
  memory_supersede_undo: "admin",
  memory_restore_version: "admin",
  memory_history_purge: "admin",
  memory_rollback: "admin",
  memory_confirm: "reply is the confirm verdict; read_it reads the registry directly",
  memory_flag: "reply is the flag verdict (id, rev), no note text",
};

async function mcp(store: Store, conn: Record<string, unknown> = { local: true }) {
  const server = createMcpServer(store, "admin", { tools: "all" }, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

describe("R1-05 guard: every MCP tool registers read-taint or is exempt", () => {
  test("every registered tool is classified", async () => {
    const store = new Store(":memory:");
    const c = await mcp(store);
    const names = (await c.listTools()).tools.map((t) => t.name);
    store.close();
    const known = new Set([...Object.keys(MCP_PROBES), ...Object.keys(MCP_EXEMPT)]);
    assert.deepEqual(names.filter((n) => !known.has(n)), [], "an MCP tool was added: add a probe to MCP_PROBES or MCP_EXEMPT with the reason it cannot carry an unconfirmed note");
  });

  for (const [tool, args] of Object.entries(MCP_PROBES)) {
    test(`${tool}: a reply with an unconfirmed note marks the connection (next write is via:memory)`, async () => {
      const store = new Store(":memory:");
      setProcessWriter("stdio");
      const web = await mcp(store, { local: true, readsOutside: true });
      const note = json(await web.callTool({ name: "state_write", arguments: { title: "vendor page", body: "SECRET-PAYLOAD-NOTE" } })).note;
      const task = json(await web.callTool({ name: "task_put", arguments: { title: "deploy vendor page", notes: "SECRET-PAYLOAD-TASK", next_step: "x" } })).task;
      const c = await mcp(store, { local: true });
      const reply = body(await c.callTool({ name: tool, arguments: args(note.id, task.id) }));
      assert.ok(reply.length > 0 && !reply.startsWith("Error"), `${tool}: ${reply.slice(0, 200)}`);
      if (!FLAGLESS.has(tool)) assert.match(reply, /unconfirmed/, `${tool}: the probe must return an unconfirmed note: ${reply.slice(0, 200)}`);
      const w = json(await c.callTool({ name: "state_write", arguments: { title: "copy", body: "laundered" } })).note;
      assert.ok(w.tags.includes(VIA), `${tool}: next write is marked: ${w.tags.join()}`);
    });
  }
});
