// Replacing a memory: only a person confirms (1.8.0). An agent can preview (read only) but cannot approve its own
// replacement, even with a valid one-time code. Person = the monomem CLI or an admin-scope REST/dashboard caller;
// never an MCP connection. MONOMEM_REPLACE_CONFIRM=agent restores the 1.6/1.7 behaviour for operators who want it.
import "./setup-env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store, type NoteRecord } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { SupersedeError, supersedePreview, supersedeConfirm, replaceConfirmMode, type Caller } from "../src/supersede.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);
const mk = (who: string, title: string, body: string): NoteRecord => as(who, () => store.create({ title, body }));

// hideArchived marks an MCP (agent) connection, exactly as tools-supersede.ts builds its caller.
const mcpWrite: Caller = { scope: "write", writer: "claude-code", hideArchived: true };
const mcpAdmin: Caller = { scope: "admin", writer: "claude-code", hideArchived: true };
const restWrite: Caller = { scope: "write", writer: "web-clipper" };
const restAdmin: Caller = { scope: "admin", writer: "dashboard" };
const cli: Caller = { scope: "admin", writer: "cli" };

let store: Store;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MONOMEM_REPLACE_CONFIRM;
  delete process.env.MONOMEM_REPLACE_CONFIRM; // the default is what ships
  store = new Store(":memory:");
});
afterEach(() => {
  if (saved === undefined) delete process.env.MONOMEM_REPLACE_CONFIRM;
  else process.env.MONOMEM_REPLACE_CONFIRM = saved;
});

const prev = (c: Caller, old: number, to: number) => as(c.writer ?? "x", () => supersedePreview(store, c, { old_ids: [old], new_id: to }));
const conf = (c: Caller, token: string) => as(c.writer ?? "x", () => supersedeConfirm(store, c, { token }));
const refused = (fn: () => unknown): SupersedeError => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SupersedeError, `expected SupersedeError, got ${String(e)}`);
    return e;
  }
  return assert.fail("expected the replacement to be refused");
};

const pair = (): { old: NoteRecord; neu: NoteRecord } => ({
  old: mk("alice", "queue name", "The queue is q1."),
  neu: mk("alice", "queue name now", "The queue is now q2."),
});

describe("who may confirm a replacement", () => {
  test("the default mode is person", () => {
    assert.equal(replaceConfirmMode(), "person");
  });

  test("an unknown setting falls back to person, never to agent", () => {
    process.env.MONOMEM_REPLACE_CONFIRM = "yes please";
    assert.equal(replaceConfirmMode(), "person");
    process.env.MONOMEM_REPLACE_CONFIRM = " AGENT ";
    assert.equal(replaceConfirmMode(), "agent");
  });

  test("an MCP agent with a write key can preview but its confirm is refused and nothing changes", () => {
    const { old, neu } = pair();
    const p = prev(mcpWrite, old.id, neu.id);
    assert.equal(p.confirm_by, "person");
    const e = refused(() => conf(mcpWrite, p.token));
    assert.equal(e.status, 403);
    assert.match(e.message, /person/i);
    assert.notEqual(store.read(old.id)!.status, "superseded", "the old note is untouched");
    assert.equal(store.supersedeLog(undefined).length, 0);
  });

  test("an MCP connection with an ADMIN key is still an agent and is refused", () => {
    const { old, neu } = pair();
    const p = prev(mcpAdmin, old.id, neu.id);
    assert.equal(refused(() => conf(mcpAdmin, p.token)).status, 403);
    assert.notEqual(store.read(old.id)!.status, "superseded");
  });

  test("a REST app with a write key is refused", () => {
    const { old, neu } = pair();
    const p = prev(restWrite, old.id, neu.id);
    assert.equal(p.confirm_by, "person");
    assert.equal(refused(() => conf(restWrite, p.token)).status, 403);
    assert.notEqual(store.read(old.id)!.status, "superseded");
  });

  test("an admin-scope REST/dashboard caller is a person and may confirm", () => {
    const { old, neu } = pair();
    const p = prev(restAdmin, old.id, neu.id);
    assert.equal(p.confirm_by, "caller");
    const out = conf(restAdmin, p.token);
    assert.equal(out.retired[0].id, old.id);
    assert.equal(store.read(old.id)!.status, "superseded");
  });

  test("the monomem CLI is a person and may confirm", () => {
    const { old, neu } = pair();
    const out = conf(cli, prev(cli, old.id, neu.id).token);
    assert.equal(out.retired[0].superseded_by, neu.id);
  });

  test("the flow the refusal teaches works: the agent saves the new note, the person confirms with their own preview", () => {
    const old = mk("alice", "queue name", "The queue is q1.");
    const neu = as("claude-code", () => store.create({ title: "queue name now", body: "The queue is now q2." })); // the agent saves normally
    refused(() => conf(mcpWrite, prev(mcpWrite, old.id, neu.id).token));
    const done = conf(cli, prev(cli, old.id, neu.id).token); // the person runs `monomem supersede --old N --new-id M`
    assert.equal(done.retired[0].id, old.id);
  });

  test("the refusal says what to do, in plain words, and how an operator can change the rule", () => {
    const { old, neu } = pair();
    const e = refused(() => conf(mcpWrite, prev(mcpWrite, old.id, neu.id).token));
    assert.match(e.message, /monomem supersede --old/);
    assert.match(e.message, /MONOMEM_REPLACE_CONFIRM=agent/);
    assert.match(e.message, /show the person/i);
  });

  test("the preview an agent gets does not tell it to confirm by itself", () => {
    const { old, neu } = pair();
    const p = as("claude-code", () =>
      supersedePreview(store, mcpWrite, { old_ids: [old.id], new_id: neu.id }, "To go ahead, call confirm with this code: {token}")
    );
    assert.doesNotMatch(p.warning, /call confirm with this code/);
    assert.match(p.warning, /person/i);
  });
});

describe("the operator opt-out", () => {
  test("MONOMEM_REPLACE_CONFIRM=agent lets an MCP agent confirm, as in 1.6 and 1.7", () => {
    process.env.MONOMEM_REPLACE_CONFIRM = "agent";
    const { old, neu } = pair();
    const out = conf(mcpWrite, prev(mcpWrite, old.id, neu.id).token);
    assert.equal(out.retired[0].id, old.id);
  });
});
