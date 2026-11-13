// Human-only pinned notes (agents read, only the CLI changes) and rolling back one writer's changes since a time.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, SCHEMA_VERSION } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { createApiServer } from "../src/api.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { supersedePreview, restoreVersion, purgeNoteHistory, type Caller } from "../src/supersede.js";
import { consolidateNotes } from "../src/consolidate.js";
import { rollbackPreview, rollbackConfirm, parseSince } from "../src/rollback.js";
import { rollbackCli, pinCli, type CliIO } from "../src/supersede-cli.js";
import { downgradeTo } from "./legacy-db.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const ADMIN: Caller = { scope: "admin" };
const parseRead = (r: any) => JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("{")));
async function connect(store: Store, conn = {}) {
  const server = createMcpServer(store, "admin", { tools: "all" }, conn);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}
function io(answer = "yes", interactive = false): CliIO & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (s) => lines.push(s), err: (s) => lines.push(s), ask: async () => answer, interactive };
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

afterEach(() => setProcessWriter(""));

describe("pinned notes", () => {
  function pinnedStore(): { store: Store; id: number } {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const n = store.create({ title: "deploy rule", body: "fridays never" });
    store.update(n.id, { body: "fridays never, ever" });
    assert.ok(store.setPinned(n.id, true));
    setProcessWriter("stdio");
    return { store, id: n.id };
  }

  test("agents are refused every change; reads show pinned: true", async () => {
    const { store, id } = pinnedStore();
    const msg = /pinned by the operator/;
    assert.throws(() => store.update(id, { body: "any day" }), msg);
    assert.throws(() => store.update(id, { tags: ["x"] }), msg, "metadata too");
    assert.throws(() => store.archive(id), msg);
    assert.throws(() => store.delete(id), msg);
    assert.throws(() => store.purgeHistory(id), msg);
    assert.throws(() => restoreVersion(store, ADMIN, id, 1), msg);
    assert.throws(() => purgeNoteHistory(store, ADMIN, id), msg);
    assert.throws(() => supersedePreview(store, ADMIN, { old_ids: [id], new_note: { title: "x", body: "y" } }), msg);
    const other = store.create({ title: "other" });
    assert.throws(() => consolidateNotes(store, [id, other.id]), msg);
    assert.equal(store.read(id)!.body, "fridays never, ever");
    assert.equal(store.historyCount(id), 1);

    const c = await connect(store, { local: true });
    const read = parseRead(await c.callTool({ name: "state_read", arguments: { id } }));
    assert.equal(read.note.pinned, true);
    const w: any = await c.callTool({ name: "state_write", arguments: { id, title: "deploy rule", body: "any day" } });
    assert.ok(w.isError);
    assert.match(w.content[0].text, msg);
    const d: any = await c.callTool({ name: "state_delete", arguments: { id } });
    assert.ok(d.isError);
    assert.match(d.content[0].text, msg);
    await c.close();
    assert.equal(store.read(other.id)!.pinned, undefined, "an unpinned note keeps its exact old shape");
    store.close();
  });

  test("the CLI changes it and pins / unpins; unpinned, agents can change it again", async () => {
    const { store, id } = pinnedStore();
    setProcessWriter("cli");
    assert.equal(store.update(id, { body: "operator edit" })!.body, "operator edit");
    const o = io();
    assert.equal(await pinCli(store, "pin", [], o), 0);
    assert.match(o.lines.join("\n"), new RegExp(`note ${id} `));
    assert.equal(await pinCli(store, "unpin", [String(id)], o), 0);
    assert.equal(await pinCli(store, "pin", ["999"], o), 1);
    setProcessWriter("stdio");
    assert.equal(store.update(id, { body: "agent edit" })!.body, "agent edit");
    assert.equal(store.read(id)!.pinned, undefined);
    store.close();
  });

  test("expiry sweep never archives a pinned note", () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const n = store.create({ title: "ttl", forget_after: 1 });
    store.setPinned(n.id, true);
    assert.equal(store.sweepExpired(Date.now() + 3 * 86_400_000), 0);
    assert.equal(store.read(n.id)!.archived_at, undefined);
    store.close();
  });

  test("REST: an admin token can pin / unpin, but changing a pinned note is refused (REST counts as an agent)", async () => {
    const store = new Store(":memory:");
    setProcessWriter("cli");
    const n = store.create({ title: "rest", body: "v1" });
    setProcessWriter("");
    const server = createApiServer(store, "tok-admin-1234567890");
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { Authorization: "Bearer tok-admin-1234567890", "Content-Type": "application/json" };
    try {
      let res = await fetch(`${base}/pinned`, { method: "PUT", headers: H, body: JSON.stringify({ id: n.id, pinned: true }) });
      assert.equal(res.status, 200);
      assert.deepEqual(((await (await fetch(`${base}/pinned`, { headers: H })).json()) as any).notes.map((x: any) => x.id), [n.id]);
      res = await fetch(`${base}/notes/${n.id}`, { method: "PUT", headers: H, body: JSON.stringify({ body: "v2" }) });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as any).error, /pinned/);
      res = await fetch(`${base}/notes/${n.id}`, { method: "DELETE", headers: H });
      assert.equal(res.status, 400);
      assert.equal(store.read(n.id)!.body, "v1");
      res = await fetch(`${base}/pinned`, { method: "PUT", headers: H, body: JSON.stringify({ id: 999, pinned: true }) });
      assert.equal(res.status, 404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });

  test("schema v18: a v17 database upgrades, notes kept and unpinned, one backup at v17", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-v18-"));
    try {
      const path = join(dir, "state.db");
      const s0 = new Store(path);
      s0.create({ title: "kept" });
      s0.close();
      downgradeTo(path, 17);
      assert.equal(Store.peekSchemaVersion(path), 17);
      const quiet = console.error;
      console.error = () => undefined;
      let s: Store;
      try {
        s = new Store(path);
      } finally {
        console.error = quiet;
      }
      assert.equal(SCHEMA_VERSION, 20);
      assert.equal(Store.peekSchemaVersion(path), 20);
      assert.equal(Store.peekSchemaVersion(path + ".pre-v20-backup"), 17);
      const n = s.list({}).notes[0];
      assert.equal(n.title, "kept");
      assert.equal(n.pinned, undefined);
      setProcessWriter("cli");
      assert.ok(s.setPinned(n.id, true));
      assert.equal(s.read(n.id)!.pinned, true);
      assert.deepEqual(s.historyDropped(n.id), []);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rollback by writer", () => {
  /** Before T: alice writes a, b, c. After T: mallory creates m, changes a twice and b once; bob changes b after her. */
  async function scene() {
    const store = new Store(":memory:");
    const a = as("alice", () => store.create({ title: "a", body: "a-good" }));
    const b = as("alice", () => store.create({ title: "b", body: "b-good" }));
    const c = as("alice", () => store.create({ title: "c", body: "c-good" }));
    await tick();
    const since = new Date().toISOString();
    await tick();
    const m = as("mallory", () => store.create({ title: "m", body: "planted" }));
    as("mallory", () => store.update(a.id, { body: "a-bad-1" }));
    as("mallory", () => store.update(a.id, { body: "a-bad-2" }));
    as("mallory", () => store.update(b.id, { body: "b-bad" }));
    as("bob", () => store.update(b.id, { body: "b-bob" }));
    return { store, a, b, c, m, since };
  }

  test("created notes are archived, changed notes get their pre-T text, later edits by others are a conflict", async () => {
    const { store, a, b, c, m, since } = await scene();
    setProcessWriter("cli");
    const p = rollbackPreview(store, ADMIN, { writer: "mallory", since });
    assert.deepEqual(p.actions.map((x) => [x.id, x.action, x.restore_version ?? 0]), [[a.id, "restore", 1], [m.id, "archive", 0]]);
    assert.deepEqual(p.skipped.map((x) => [x.id, x.reason]), [[b.id, "conflict"]]);
    assert.match(p.skipped[0].detail, /bob/);
    assert.match(p.warning, /Archive 1 note/);
    const out = rollbackConfirm(store, ADMIN, { token: p.token });
    assert.deepEqual(out.archived, [m.id]);
    assert.equal(store.read(m.id)!.archived_at !== undefined, true);
    assert.equal(store.read(a.id)!.body, "a-good");
    assert.equal(store.read(b.id)!.body, "b-bob", "the conflict was skipped");
    assert.equal(store.read(c.id)!.body, "c-good");
    // Undo: the rolled-back text is in the history.
    const h = store.historyOf(a.id)[0];
    assert.equal(h.body, "a-bad-2");
    assert.equal(h.reason, "rollback");
    store.restoreVersion(a.id, h.version);
    assert.equal(store.read(a.id)!.body, "a-bad-2");
    store.close();
  });

  test("include_conflicts restores the conflicting note too", async () => {
    const { store, b, since } = await scene();
    setProcessWriter("cli");
    const p = rollbackPreview(store, ADMIN, { writer: "mallory", since, include_conflicts: true });
    assert.ok(p.actions.find((x) => x.id === b.id)?.conflict);
    rollbackConfirm(store, ADMIN, { token: p.token });
    assert.equal(store.read(b.id)!.body, "b-good");
    assert.equal(store.historyOf(b.id)[0].body, "b-bob", "bob's text is kept in the history");
    store.close();
  });

  test('"stdio" covers every stdio:<app>; an exact name does not', async () => {
    const store = new Store(":memory:");
    const since = new Date(Date.now() - 1000).toISOString();
    setProcessWriter("stdio:cursor");
    const x = store.create({ title: "from cursor" });
    setProcessWriter("stdio:claude-code");
    const y = store.create({ title: "from claude" });
    setProcessWriter("cli");
    assert.deepEqual(rollbackPreview(store, ADMIN, { writer: "stdio", since }).actions.map((a) => a.id), [x.id, y.id]);
    assert.deepEqual(rollbackPreview(store, ADMIN, { writer: "stdio:cursor", since }).actions.map((a) => a.id), [x.id]);
    assert.deepEqual(rollbackPreview(store, ADMIN, { writer: "std", since }).actions, []);
    store.close();
  });

  test("a pruned pre-T version is reported as cannot fully undo, never guessed", async () => {
    const prev = process.env.MONOMEM_HISTORY_VERSIONS;
    process.env.MONOMEM_HISTORY_VERSIONS = "1";
    try {
      const store = new Store(":memory:");
      const n = as("alice", () => store.create({ title: "n", body: "v1" }));
      as("alice", () => store.update(n.id, { body: "v2" }));
      await tick();
      const since = new Date().toISOString();
      await tick();
      as("mallory", () => store.update(n.id, { body: "bad" }));
      assert.deepEqual(store.historyOf(n.id).map((e) => e.body), ["v1"], "the version mallory replaced was pruned");
      setProcessWriter("cli");
      const p = rollbackPreview(store, ADMIN, { writer: "mallory", since });
      assert.deepEqual(p.actions, []);
      assert.deepEqual(p.skipped.map((s) => s.reason), ["cannot_fully_undo"]);
      store.close();
    } finally {
      if (prev === undefined) delete process.env.MONOMEM_HISTORY_VERSIONS;
      else process.env.MONOMEM_HISTORY_VERSIONS = prev;
    }
  });

  test("the code is single-use, expires, is bound to the caller; confirm is all-or-nothing", async () => {
    const { store, a, m, since } = await scene();
    setProcessWriter("cli");
    const p = rollbackPreview(store, ADMIN, { writer: "mallory", since });
    assert.throws(() => rollbackConfirm(store, { scope: "admin", writer: "someone-else" }, { token: p.token }), /not a valid confirmation code/);
    const real = Date.now;
    Date.now = () => real() + 2 * 3_600_000;
    try {
      assert.throws(() => rollbackConfirm(store, ADMIN, { token: p.token }), /expired/);
    } finally {
      Date.now = real;
    }
    // A note changed after the preview: nothing at all is applied (m stays live too).
    as("mallory", () => store.update(a.id, { body: "a-bad-3" }));
    assert.throws(() => rollbackConfirm(store, ADMIN, { token: p.token }), /changed since the preview/);
    assert.equal(store.read(m.id)!.archived_at, undefined);
    assert.equal(store.read(a.id)!.body, "a-bad-3");
    const p2 = rollbackPreview(store, ADMIN, { writer: "mallory", since });
    rollbackConfirm(store, ADMIN, { token: p2.token });
    assert.throws(() => rollbackConfirm(store, ADMIN, { token: p2.token }), /already used/);
    store.close();
  });

  test("pinned notes: listed and rolled back from the CLI, skipped as operator-only for an agent (REST/MCP)", async () => {
    const { store, a, since } = await scene();
    setProcessWriter("cli");
    store.setPinned(a.id, true);
    setProcessWriter("");
    const agent = as("admin-token", () => rollbackPreview(store, ADMIN, { writer: "mallory", since }));
    assert.deepEqual(agent.skipped.filter((s) => s.reason === "operator_only").map((s) => s.id), [a.id]);
    setProcessWriter("cli");
    const o = io();
    assert.equal(await rollbackCli(store, ["--writer", "mallory", "--since", since, "--yes"], o), 0);
    assert.match(o.lines.join("\n"), /\(PINNED\)/);
    assert.equal(store.read(a.id)!.body, "a-good");
    store.close();
  });

  test("CLI without a terminal and without --yes only previews", async () => {
    const { store, m, since } = await scene();
    setProcessWriter("cli");
    assert.equal(await rollbackCli(store, ["--writer", "mallory", "--since", since], io("yes", false)), 2);
    assert.equal(store.read(m.id)!.archived_at, undefined);
    assert.equal(await rollbackCli(store, ["--writer", "mallory", "--since", since], io("no", true)), 1);
    assert.equal(store.read(m.id)!.archived_at, undefined);
    store.close();
  });

  test("operator-only over MCP: off over stdio by default, on with MONOMEM_STDIO_ADMIN_TOOLS=1; needs admin", async () => {
    const store = new Store(":memory:");
    let c = await connect(store, { local: true });
    assert.ok(!(await c.listTools()).tools.some((t) => t.name === "memory_rollback"));
    await c.close();
    process.env.MONOMEM_STDIO_ADMIN_TOOLS = "1";
    try {
      c = await connect(store, { local: true });
      const since = new Date(Date.now() - 1000).toISOString();
      const n = as("x", () => store.create({ title: "x note" }));
      const r: any = await c.callTool({ name: "memory_rollback", arguments: { writer: "x", since } });
      assert.ok(!r.isError, r.content[0].text);
      const code = parseRead(r).token;
      const done: any = await c.callTool({ name: "memory_rollback", arguments: { code } });
      assert.ok(!done.isError, done.content[0].text);
      assert.ok(store.read(n.id)!.archived_at);
      await c.close();
    } finally {
      delete process.env.MONOMEM_STDIO_ADMIN_TOOLS;
    }
    assert.throws(() => rollbackPreview(store, { scope: "write" }, { writer: "x", since: "1h" }), /administrators/);
    store.close();
  });

  test("since accepts ISO times and durations, refuses junk and the future", () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    assert.equal(parseSince("2h", now), "2026-11-04T10:00:00.000Z");
    assert.equal(parseSince("2026-11-01T00:00:00Z", now), "2026-11-01T00:00:00.000Z");
    assert.throws(() => parseSince("yesterday-ish", now));
    assert.throws(() => parseSince("2027-01-01", now), /future/);
    assert.throws(() => parseSince(undefined, now));
  });
});
