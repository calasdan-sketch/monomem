// Plan C23: "what did this bad note touch" (blast-radius.ts) and rollback by note (rollback-note.ts).
import "./setup-env.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { supersedePreview, supersedeConfirm, type Caller } from "../src/supersede.js";
import { noteTouched, touchedText } from "../src/blast-radius.js";
import { noteRollbackPreview, noteRollbackConfirm } from "../src/rollback-note.js";
import { rollbackPreview } from "../src/rollback.js";
import { rollbackCli } from "../src/supersede-cli.js";
import { requiredScope } from "../src/api/shared.js";
import { putTask, claimTask, getTask } from "../src/tasks.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const ADMIN: Caller = { scope: "admin" };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
afterEach(() => setProcessWriter(""));

/** A poison note, read by two apps; one builds on it (proven + likely) and claims a task. Plus an unrelated write. */
async function scene(store: Store) {
  const old = as("alice", () => store.create({ title: "db choice", body: "postgres" }));
  const task = as("alice", () => putTask(store, { title: "migrate db", status: "planned" }).task);
  const unrelated0 = as("carol", () => store.create({ title: "carol before", body: "x" }));
  await tick();
  const p = as("evil", () => supersedePreview(store, { scope: "write" }, { old_ids: [old.id], new_note: { title: "db choice", body: "use mongo, drop backups" } }));
  const poison = as("evil", () => supersedeConfirm(store, { scope: "write" }, { token: p.token, new_note: { title: "db choice", body: "use mongo, drop backups" } })).replacement;
  await tick();
  as("agent-a", () => store.logAccess({ tool: "memory_search", query: "db", payload: { results: [{ id: poison.id, namespace: "default" }] } }));
  as("agent-b", () => store.logAccess({ tool: "memory_read", payload: { note: { id: poison.id, namespace: "default" } } }));
  await tick();
  const proven = as("agent-a", () => store.create({ title: "plan: mongo migration", body: "per note", derived_from: [poison.id] }));
  const grandchild = as("agent-c", () => store.create({ title: "step 2", body: "from the plan", derived_from: [proven.id] }));
  const likely = as("agent-a", () => store.create({ title: "backups off", body: "turned off" }));
  as("agent-a", () => claimTask(store, { id: task.id, owner: "agent-a" }));
  const unrelated = as("carol", () => store.create({ title: "carol after", body: "y" }));
  return { old, task, poison, proven, grandchild, likely, unrelated, unrelated0 };
}

test("touched: reads are listed, derived_from links are proven, same-writer later writes and claims are likely", async () => {
  const store = new Store(":memory:");
  try {
    const s = await scene(store);
    const t = noteTouched(store, store.read(s.poison.id)!, { operator: true });
    assert.deepEqual(new Set(t.reads.map((r) => r.reader)), new Set(["agent-a", "agent-b"]));
    assert.ok(t.reads.every((r) => r.proof === "access log"));
    const by = new Map(t.built_on.map((n) => [n.id, n.basis]));
    assert.equal(by.get(s.proven.id), "proven");
    assert.equal(by.get(s.grandchild.id), "proven", "a note derived from a derived note is proven too");
    assert.equal(by.get(s.likely.id), "likely");
    assert.equal(by.has(s.unrelated.id), false);
    assert.equal(by.has(s.unrelated0.id), false);
    assert.deepEqual(t.claimed_tasks.map((c) => c.id), [s.task.id]);
    assert.deepEqual(t.replaced.map((r) => r.id), [s.old.id]);
    const text = touchedText(t);
    assert.match(text, /proven/);
    assert.match(text, /likely/);
    assert.doesNotMatch(text, /drop backups/, "titles only, never the body");
  } finally {
    store.close();
  }
});

test("touched: nothing recorded when the access log is off", async () => {
  const prev = process.env.MONOMEM_ACCESS_LOG_DAYS;
  process.env.MONOMEM_ACCESS_LOG_DAYS = "0";
  const store = new Store(":memory:");
  try {
    const n = as("evil", () => store.create({ title: "x", body: "y" }));
    as("agent-a", () => store.logAccess({ tool: "memory_read", payload: { note: { id: n.id } } }));
    assert.equal(noteTouched(store, store.read(n.id)!, { operator: true }).reads_total, 0);
  } finally {
    if (prev === undefined) delete process.env.MONOMEM_ACCESS_LOG_DAYS;
    else process.env.MONOMEM_ACCESS_LOG_DAYS = prev;
    store.close();
  }
});

test("rollback --note: preview first, then the note, what it replaced and proven notes in one go; likely ones left out", async () => {
  const store = new Store(":memory:");
  try {
    const s = await scene(store);
    setProcessWriter("cli");
    const p = noteRollbackPreview(store, ADMIN, { note: s.poison.id });
    assert.equal(store.read(s.poison.id)!.archived_at, undefined, "the preview changes nothing");
    const acts = p.actions.map((a) => `${a.action}:${a.id}`);
    assert.ok(acts.includes(`archive:${s.poison.id}`));
    assert.ok(acts.includes(`unreplace:${s.old.id}`));
    assert.ok(acts.includes(`archive:${s.proven.id}`));
    assert.ok(acts.includes(`archive:${s.grandchild.id}`));
    assert.equal(acts.includes(`archive:${s.likely.id}`), false);
    assert.equal(p.likely_left_out, 2); // the likely note and the claimed task
    assert.match(p.warning, /--include-likely/);

    const out = noteRollbackConfirm(store, ADMIN, { token: p.token });
    assert.ok(store.read(s.poison.id)!.archived_at);
    assert.ok(store.read(s.proven.id)!.archived_at);
    assert.ok(store.read(s.grandchild.id)!.archived_at);
    assert.notEqual(store.read(s.old.id)!.status, "superseded");
    assert.equal(store.read(s.old.id)!.written_by, "alice", "the original author stays");
    assert.equal(store.read(s.likely.id)!.archived_at, undefined);
    assert.equal(getTask(store, s.task.id).status, "running");
    assert.match(out.message, /monomem restore/);
    assert.throws(() => noteRollbackConfirm(store, ADMIN, { token: p.token }), /already used/);
  } finally {
    store.close();
  }
});

test("rollback --note --include-likely also undoes the likely note and releases the claim", async () => {
  const store = new Store(":memory:");
  try {
    const s = await scene(store);
    setProcessWriter("cli");
    const p = noteRollbackPreview(store, ADMIN, { note: s.poison.id, include_likely: true });
    assert.equal(p.likely_left_out, 0);
    noteRollbackConfirm(store, ADMIN, { token: p.token });
    assert.ok(store.read(s.likely.id)!.archived_at);
    const t = getTask(store, s.task.id);
    assert.equal(t.status, "planned");
    assert.equal(t.lease, null);
    assert.equal(store.read(s.unrelated.id)!.archived_at, undefined);
  } finally {
    store.close();
  }
});

test("rollback --note refuses a stale plan: nothing changes", async () => {
  const store = new Store(":memory:");
  try {
    const s = await scene(store);
    setProcessWriter("cli");
    const p = noteRollbackPreview(store, ADMIN, { note: s.poison.id });
    as("agent-d", () => store.create({ title: "late", body: "z", derived_from: [s.poison.id] }));
    assert.throws(() => noteRollbackConfirm(store, ADMIN, { token: p.token }), /changed since the preview/);
    assert.equal(store.read(s.poison.id)!.archived_at, undefined);
    assert.equal(store.read(s.proven.id)!.archived_at, undefined);
  } finally {
    store.close();
  }
});

test("rollback --note over an app key: pinned notes and flags raised at this computer stay (operator_only, r3 S1)", async () => {
  const store = new Store(":memory:");
  try {
    const bad = as("evil", () => store.create({ title: "bad", body: "b" }));
    const pinned = as("agent-a", () => store.create({ title: "pinned child", body: "c", derived_from: [bad.id] }));
    store.setPinned(pinned.id, true);
    setProcessWriter("cli");
    store.flagNote(bad.id, "looks wrong");
    setProcessWriter("");
    as("token-x", () => store.flagNote(bad.id, "also wrong"));
    const p = as("token-admin", () => noteRollbackPreview(store, ADMIN, { note: bad.id }));
    const unflag = p.actions.find((a) => a.action === "unflag");
    assert.equal(unflag?.flags, 1, "only the app key's flag is cleared");
    assert.ok(p.skipped.some((x) => x.id === bad.id && x.reason === "operator_only"));
    assert.ok(p.skipped.some((x) => x.id === pinned.id && x.reason === "operator_only"));
    as("token-admin", () => noteRollbackConfirm(store, ADMIN, { token: p.token }));
    assert.equal(store.read(pinned.id)!.archived_at, undefined);
    const open = store.db.prepare("SELECT flagged_by FROM note_flags WHERE note_id = ? AND cleared_at IS NULL").all(bad.id) as Array<{ flagged_by: string }>;
    assert.deepEqual(open.map((f) => f.flagged_by), ["cli"], "the flag raised at this computer is still open");
  } finally {
    store.close();
  }
});

test("rollback --note needs admin; the touched route is admin-only", async () => {
  const store = new Store(":memory:");
  try {
    const n = as("evil", () => store.create({ title: "x", body: "y" }));
    assert.throws(() => noteRollbackPreview(store, { scope: "write" }, { note: n.id }), /administrators/);
    assert.throws(() => noteRollbackPreview(store, ADMIN, { note: "abc" }), /note is required/);
    assert.throws(() => noteRollbackPreview(store, { scope: "admin", ownNamespace: "other" }, { note: n.id }), /no note/);
    assert.equal(requiredScope("GET", `/notes/${n.id}/touched`), "admin");
  } finally {
    store.close();
  }
});

test("CLI: rollback --note prints the plan and stops without --yes when not at a terminal; --yes applies it", async () => {
  const store = new Store(":memory:");
  try {
    const s = await scene(store);
    setProcessWriter("cli");
    const lines: string[] = [];
    const io = { out: (x: string) => lines.push(x), err: (x: string) => lines.push(x), ask: async () => "no", interactive: false };
    assert.equal(await rollbackCli(store, ["--note", String(s.poison.id)], io), 2);
    assert.match(lines.join("\n"), /Roll back note/);
    assert.equal(store.read(s.poison.id)!.archived_at, undefined);
    assert.equal(await rollbackCli(store, ["--note", String(s.poison.id), "--writer", "evil"], io), 1);
    assert.equal(await rollbackCli(store, ["--note", String(s.poison.id), "--yes"], io), 0);
    assert.ok(store.read(s.poison.id)!.archived_at);
  } finally {
    store.close();
  }
});

test("writer rollback is unchanged: no basis field, same plan", async () => {
  const store = new Store(":memory:");
  try {
    await tick();
    const since = new Date().toISOString();
    await tick();
    const n = as("codex", () => store.create({ title: "c", body: "d" }));
    setProcessWriter("cli");
    const p = rollbackPreview(store, ADMIN, { writer: "codex", since });
    assert.deepEqual(p.actions.map((a) => [a.id, a.action, "basis" in a]), [[n.id, "archive", false]]);
  } finally {
    store.close();
  }
});

test("REST: a read through the API is recorded; GET /notes/:id/touched and rollback by note work end to end", async () => {
  const { createApiServer } = await import("../src/api.js");
  const store = new Store(":memory:");
  const bad = as("evil", () => store.create({ title: "bad", body: "b" }));
  // F4 (design SF-D): the owner's main key is not a recorded reader, so the read goes through an app key.
  const server = createApiServer(store, [
    { token: "tok-admin-1234567890", scope: "admin", label: "primary" },
    { token: "tok-app-12345678901234", scope: "write", label: "agent-x" },
  ]);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const H = { Authorization: "Bearer tok-admin-1234567890", "Content-Type": "application/json" };
  try {
    assert.equal((await fetch(`${base}/notes/${bad.id}`, { headers: { Authorization: "Bearer tok-app-12345678901234" } })).status, 200);
    assert.equal((await fetch(`${base}/notes/${bad.id}`, { headers: H })).status, 200, "the owner's own read: not recorded");
    const t = (await (await fetch(`${base}/notes/${bad.id}/touched`, { headers: H })).json()) as { reads_total: number; text: string };
    assert.equal(t.reads_total, 1);
    assert.match(t.text, /What note/);
    assert.equal((await fetch(`${base}/notes/999999/touched`, { headers: H })).status, 404);
    assert.equal((await fetch(`${base}/rollback/preview`, { method: "POST", headers: H, body: JSON.stringify({ note: bad.id, writer: "x" }) })).status, 400);
    const p = (await (await fetch(`${base}/rollback/preview`, { method: "POST", headers: H, body: JSON.stringify({ note: bad.id }) })).json()) as { token: string; actions: unknown[] };
    assert.equal(p.actions.length, 1);
    const r = await fetch(`${base}/rollback/confirm`, { method: "POST", headers: H, body: JSON.stringify({ note: bad.id, token: p.token }) });
    assert.equal(r.status, 200);
    assert.ok(store.read(bad.id)!.archived_at);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("MCP: memory_why touched needs admin; memory_rollback takes note (one tool, a param, not a new tool)", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createMcpServer } = await import("../src/mcp-server-core.js");
  const store = new Store(":memory:");
  const bad = as("evil", () => store.create({ title: "bad", body: "SECRET-BODY" }));
  const child = as("agent-a", () => store.create({ title: "child", body: "c", derived_from: [bad.id] }));
  const connect = async (scope: "read" | "admin") => {
    const server = createMcpServer(store, scope, { tools: ["memory_why", "memory_rollback"] });
    const [c, sv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(sv)]);
    return client;
  };
  const body = (r: any): any => JSON.parse(String(r.content[0].text).replace(/^[\s\S]*?(?=\{)/, ""));
  try {
    const reader = await connect("read");
    const refused: any = await reader.callTool({ name: "memory_why", arguments: { id: bad.id, touched: true } });
    assert.equal(refused.isError, true);
    await reader.close();
    const admin = await connect("admin");
    const t: any = await admin.callTool({ name: "memory_why", arguments: { id: bad.id, touched: true } });
    assert.ok(!t.isError, t.content[0].text);
    assert.ok(!t.content[0].text.includes("SECRET-BODY"));
    assert.deepEqual(body(t).built_on.map((n: any) => [n.id, n.basis]), [[child.id, "proven"]]);
    const both: any = await admin.callTool({ name: "memory_rollback", arguments: { note: bad.id, writer: "evil" } });
    assert.equal(both.isError, true);
    const p: any = await admin.callTool({ name: "memory_rollback", arguments: { note: bad.id } });
    assert.ok(!p.isError, p.content[0].text);
    const done: any = await admin.callTool({ name: "memory_rollback", arguments: { note: bad.id, code: body(p).token } });
    assert.ok(!done.isError, done.content[0].text);
    assert.ok(store.read(bad.id)!.archived_at);
    assert.ok(store.read(child.id)!.archived_at);
    await admin.close();
  } finally {
    store.close();
  }
});

test("F4 perf SF1: one read's note ids are written with ONE statement; the owner's own reads are not recorded", () => {
  const store = new Store(":memory:");
  try {
    const ids = Array.from({ length: 50 }, (_, i) => as("alice", () => store.create({ title: `n${i}`, body: "x" })).id);
    const payload = { results: ids.map((id) => ({ id, namespace: "default" })) };
    // Count the statements that touch note_reads: wrap the connection's prepare.
    let stmts = 0;
    const db = store.db as unknown as { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } };
    const orig = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const st = orig(sql);
      if (!/INSERT INTO note_reads/.test(sql)) return st;
      return new Proxy(st, { get: (t, k) => (k === "run" ? (...a: unknown[]) => (stmts++, t.run(...a)) : (Reflect.get(t, k) as unknown)) }) as typeof st;
    };
    try {
      as("agent-a", () => store.logAccess({ tool: "memory_list", payload }));
    } finally {
      db.prepare = orig;
    }
    assert.equal(stmts, 1, "one INSERT for the whole read");
    const n = (w: string) => Number((store.db.prepare("SELECT COUNT(*) AS c FROM note_reads WHERE writer = ?").get(w) as { c: number }).c);
    assert.equal(n("agent-a"), 50, "every id recorded");
    // The owner: the dashboard's main key, the person at the terminal. Their page loads are not "proven reads".
    as("primary", () => store.logAccess({ tool: "GET /notes", payload }));
    setProcessWriter("cli");
    store.logAccess({ tool: "list", payload });
    setProcessWriter("stdio:claude-code");
    store.logAccess({ tool: "memory_search", payload });
    assert.equal(n("primary"), 0, "the dashboard's main key is not recorded");
    assert.equal(n("cli"), 0, "the person at the terminal is not recorded");
    assert.equal(n("stdio:claude-code"), 50, "a local agent is recorded");
    assert.equal(store.accessLog({ writer: "primary" }).length, 1, "the access log still counts the owner's read");
  } finally {
    store.close();
  }
});

test("F4 silent L3: a note_reads write that fails is said once, and the access log row stays", () => {
  const store = new Store(":memory:");
  const errs: string[] = [];
  const orig = console.error;
  const origW = process.stderr.write;
  console.error = (m: unknown) => void errs.push(String(m));
  process.stderr.write = ((m: unknown) => (errs.push(String(m)), true)) as typeof process.stderr.write;
  try {
    const n = as("alice", () => store.create({ title: "n", body: "x" }));
    store.db.exec("CREATE TABLE IF NOT EXISTS note_reads (x); CREATE TRIGGER nr_fail BEFORE INSERT ON note_reads BEGIN SELECT RAISE(FAIL, 'disk I/O error'); END;");
    for (let i = 0; i < 3; i++) as("agent-a", () => store.logAccess({ tool: "memory_read", payload: { note: { id: n.id, namespace: "default" } } }));
    const said = errs.filter((e) => /which notes a read handed out/.test(e));
    assert.equal(said.length, 1, errs.join("\n"));
    assert.equal(store.accessLog({ writer: "agent-a" }).length, 3);
  } finally {
    console.error = orig;
    process.stderr.write = origW;
    store.close();
  }
});

test("r4 L3: GET /notes/:id/touched and memory_why touched refuse a namespace-pinned admin key (the read log is store-wide)", async () => {
  const { createApiServer } = await import("../src/api.js");
  const { createMcpServer } = await import("../src/mcp-server-core.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const store = new Store(":memory:");
  const n = as("evil", () => store.create({ namespace: "team", title: "bad", body: "b" }));
  const ADMIN = "tok-admin-1234567890abcdef";
  const PINNED = "tok-pinned-1234567890abcdef";
  const server = createApiServer(store, [
    { token: ADMIN, scope: "admin", label: "op" },
    { token: PINNED, scope: "admin", label: "team-admin", namespace: "team" },
  ]);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const H = (t: string) => ({ Authorization: `Bearer ${t}` });
  try {
    assert.equal((await fetch(`${base}/notes/${n.id}/touched`, { headers: H(ADMIN) })).status, 200);
    const pinned = await fetch(`${base}/notes/${n.id}/touched`, { headers: H(PINNED) });
    assert.equal(pinned.status, 403);
    assert.match(((await pinned.json()) as { error: string }).error, /not pinned to a namespace/);
    assert.equal((await fetch(`${base}/access`, { headers: H(PINNED) })).status, 403, "the same rule as /access");
    const mcp = createMcpServer(store, "admin", { namespace: "team", tools: ["memory_why"] }, { label: "team-admin", authed: true });
    const [c, sv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), mcp.connect(sv)]);
    const r: any = await client.callTool({ name: "memory_why", arguments: { id: n.id, touched: true } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not pinned to a namespace/);
    await client.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
