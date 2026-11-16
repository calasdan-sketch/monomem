// r2-improvement #2: rolling back a writer undoes its replacements, flags and task claims too, and a restored note keeps its
// original author.
import "./setup-env.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { supersedePreview, supersedeConfirm, type Caller } from "../src/supersede.js";
import { rollbackPreview, rollbackConfirm } from "../src/rollback.js";
import { putTask, claimTask, getTask } from "../src/tasks.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const ADMIN: Caller = { scope: "admin" };
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
afterEach(() => setProcessWriter(""));

test("rollback undoes a writer's write, update, replacement, flag and task claim; authorship comes back", async () => {
  const store = new Store(":memory:");
  try {
    const fact = as("claude-code", () => store.create({ title: "deploy target", body: "fly.io", tags: ["fact:deploy_target=fly.io"] }));
    const old = as("claude-code", () => store.create({ title: "db choice", body: "postgres" }));
    const good = as("claude-code", () => store.create({ title: "test runner", body: "node --test" }));
    const task = as("claude-code", () => putTask(store, { title: "ship it", status: "planned" }).task);
    await tick();
    const since = new Date().toISOString();
    await tick();
    // codex goes bad
    as("codex", () => store.update(fact.id, { body: "render.com", tags: ["fact:deploy_target=render.com"] }));
    const p = as("codex", () => supersedePreview(store, { scope: "write" }, { old_ids: [old.id], new_note: { title: "db choice", body: "mongo" } }));
    as("codex", () => supersedeConfirm(store, { scope: "write" }, { token: p.token, new_note: { title: "db choice", body: "mongo" } }));
    assert.equal(store.read(old.id)!.status, "superseded");
    as("codex", () => store.flagNote(good.id, "this is wrong"));
    assert.ok((store.read(good.id)!.flagged ?? []).length > 0);
    as("codex", () => claimTask(store, { id: task.id, owner: "codex" }));
    assert.equal(getTask(store, task.id).status, "running");

    setProcessWriter("cli");
    const plan = rollbackPreview(store, ADMIN, { writer: "codex", since });
    assert.match(plan.warning, /replace/i);
    assert.match(plan.warning, /flag/i);
    assert.match(plan.warning, /claim/i);
    rollbackConfirm(store, ADMIN, { token: plan.token });
    setProcessWriter("");

    // the update is reverted AND the author is the original writer again
    const f = store.read(fact.id)!;
    assert.equal(f.body, "fly.io");
    assert.equal(f.written_by, "claude-code");
    // the replacement is undone: the old note is live again
    const o = store.read(old.id)!;
    assert.equal(o.status === "superseded", false);
    assert.equal(o.archived_at, undefined);
    // the flag is cleared
    assert.equal((store.read(good.id)!.flagged ?? []).length, 0);
    // the claim is released and the status put back
    const t = getTask(store, task.id);
    assert.equal(t.lease, null);
    assert.equal(t.status, "planned");
    assert.equal(t.owner, "");
  } finally {
    store.close();
  }
});

test("rollback leaves another writer's later claim alone", async () => {
  const store = new Store(":memory:");
  try {
    const task = as("alice", () => putTask(store, { title: "x", status: "idea" }).task);
    await tick();
    const since = new Date().toISOString();
    await tick();
    as("bob", () => claimTask(store, { id: task.id, owner: "bob" }));
    setProcessWriter("cli");
    const plan = rollbackPreview(store, ADMIN, { writer: "codex", since });
    assert.equal(plan.actions.length, 0);
    assert.equal(getTask(store, task.id).lease?.owner, "bob");
  } finally {
    store.close();
  }
});
