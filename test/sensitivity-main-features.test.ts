// Sensitivity ceilings against the features added in Monomem 1.1/1.2 (pin, rollback, receipts, why, fact conflicts, access log, meter,
// session neighbours): none of them may name, count or weigh a note above the caller's ceiling.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { createApiServer } from "../src/api.js";
import { receiptAdd, receiptGet, receiptList } from "../src/receipts.js";
import { noteWhy } from "../src/why.js";
import { planRollback } from "../src/rollback.js";
import type { Sensitivity } from "../src/sensitivity.js";

function as<T>(max: Sensitivity | undefined, fn: () => T, label = "tok"): T {
  return actorStore.run({ label, authed: true, ...(max ? { maxSensitivity: max } : {}), canDeclassify: true }, fn);
}
const dump = (v: unknown): string => JSON.stringify(v);

describe("ceilings and the 1.1/1.2 features", () => {
  test("pinned list and rollback candidates skip notes above the ceiling", () => {
    const s = new Store(":memory:");
    const open = as(undefined, () => s.create({ title: "open pinned", body: "a", sensitivity: "public" }), "alice");
    const secret = as(undefined, () => s.create({ title: "SECRETTITLE pinned", body: "b", sensitivity: "private" }), "alice");
    s.setPinned(open.id, true);
    s.setPinned(secret.id, true);
    assert.equal(s.pinnedNotes().length, 2, "the operator sees both");
    assert.deepEqual(as("public", () => s.pinnedNotes()).map((n) => n.id), [open.id]);
    assert.ok(!dump(as("public", () => s.pinnedNotes())).includes("SECRETTITLE"));
    const since = new Date(Date.now() - 3600_000).toISOString();
    assert.deepEqual(s.rollbackCandidates("alice", false, since).sort(), [open.id, secret.id].sort());
    assert.deepEqual(as("public", () => s.rollbackCandidates("alice", false, since)), [open.id]);
    assert.ok(!as("public", () => planRollback(s, "alice", since, false)).actions.some((a) => a.id === secret.id));
    s.close();
  });

  test("fact conflicts never name a note above the ceiling", () => {
    const s = new Store(":memory:");
    const hidden = as(undefined, () => s.create({ title: "HIDDENDEPLOY", body: "deploy target is heroku", sensitivity: "private", tags: ["fact:deploy_target=heroku"] }), "alice");
    assert.equal(s.liveFactNotes(hidden.namespace, "deploy_target", 0).length, 1, "the operator sees it");
    assert.equal(as("public", () => s.liveFactNotes(hidden.namespace, "deploy_target", 0)).length, 0);
    assert.equal(as("public", () => s.liveFactNotesIn(undefined)).length, 0);
    s.close();
  });

  test("receipts: a ceilinged caller does not see, count or weigh hidden notes", () => {
    const s = new Store(":memory:");
    const open = as(undefined, () => s.create({ title: "visible", body: "a", sensitivity: "public" }));
    const secret = as(undefined, () => s.create({ title: "SECRETTITLE", body: "b", sensitivity: "private" }));
    receiptAdd(s, { sessionId: "S1", namespace: "default", client: "c", shown: [{ id: open.id, why: "recent", tokens: 10 }, { id: secret.id, why: "recent", tokens: 999 }] });
    assert.equal(receiptList(s)[0].notes, 2);
    const seen = as("public", () => receiptList(s));
    assert.equal(seen[0].notes, 1);
    assert.equal(seen[0].tokens, 10);
    const r = as("public", () => receiptGet(s, "S1"))!;
    assert.deepEqual(r.notes.map((n) => n.id), [open.id]);
    assert.ok(!dump(r).includes("SECRETTITLE"));
    // A session that showed only hidden notes does not exist for the limited caller.
    receiptAdd(s, { sessionId: "S2", namespace: "default", client: "c", shown: [{ id: secret.id, why: "recent", tokens: 5 }] });
    assert.equal(as("public", () => receiptGet(s, "S2")), null);
    assert.ok(as("public", () => receiptList(s)).every((x) => x.session_id !== "S2"));
    s.close();
  });

  test("why names a hidden replacement as 'another note'", () => {
    const s = new Store(":memory:");
    const old = as(undefined, () => s.create({ title: "old", body: "a", sensitivity: "public" }));
    const repl = as(undefined, () => s.create({ title: "new", body: "b", sensitivity: "private" }));
    const db = (s as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db;
    db.prepare("INSERT INTO supersede_log (at, actor, action, old_id, new_id) VALUES (?, ?, ?, ?, ?)").run(new Date().toISOString(), "you", "retire", old.id, repl.id);
    const story = as("public", () => noteWhy(s, s.readVisible(old.id)!));
    assert.ok(!dump(story).includes(`#${repl.id}`), dump(story));
    assert.match(dump(story), /another note/);
    const op = noteWhy(s, s.readVisible(old.id)!);
    assert.ok(dump(op).includes(`#${repl.id}`), "the operator sees the id");
    s.close();
  });

  test("REST: /access is refused for a key with a ceiling, and /stats carries no meter for it", async () => {
    const s = new Store(":memory:");
    const toks = [
      { token: "a".repeat(40), scope: "admin" as const, label: "op" },
      { token: "b".repeat(40), scope: "admin" as const, label: "limited-admin", max_sensitivity: "internal" as const },
    ];
    const server = createApiServer(s, toks);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (tok: string, p: string): Promise<{ status: number; body: any }> => {
      const r = await fetch(base + p, { headers: { Authorization: `Bearer ${tok}` } });
      return { status: r.status, body: await r.json() };
    };
    assert.equal((await get(toks[0].token, "/access")).status, 200);
    const denied = await get(toks[1].token, "/access");
    assert.equal(denied.status, 403);
    assert.match(denied.body.error, /no sensitivity limit/);
    assert.ok("meter" in (await get(toks[0].token, "/stats")).body);
    assert.ok(!("meter" in (await get(toks[1].token, "/stats")).body));
    await new Promise<void>((r) => server.close(() => r()));
    s.close();
  });
});
