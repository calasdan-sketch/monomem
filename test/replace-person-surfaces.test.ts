// The person-confirm rule on the two surfaces the unit test cannot reach (code-review F1, F3):
//  - a REAL MCP connection, with a write key and with an ADMIN key, is never a person, so memory_supersede_confirm is refused;
//    deleting `hideArchived: true` from tools-supersede.ts would make the admin case pass and this test fail.
//  - the command line refuses --confirm-token when there is no terminal (a script, or an agent's shell tool).
import "./setup-env.js";
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/store.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { actorStore } from "../src/actor.js";
import { supersedeCli, type CliIO } from "../src/supersede-cli.js";

let store: Store;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MONOMEM_REPLACE_CONFIRM;
  delete process.env.MONOMEM_REPLACE_CONFIRM; // the shipped default: person
  store = new Store(":memory:");
});
afterEach(() => {
  if (saved === undefined) delete process.env.MONOMEM_REPLACE_CONFIRM;
  else process.env.MONOMEM_REPLACE_CONFIRM = saved;
  store.close();
});

const mk = (title: string, body: string) => actorStore.run({ label: "alice", authed: true }, () => store.create({ title, body }));
const text = (r: any): string => r.content[0].text as string;

async function connect(scope: "write" | "admin"): Promise<Client> {
  const server = createMcpServer(store, scope, {} as never, { label: "claude-code", authed: true });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

describe("a real MCP connection is never a person", () => {
  for (const scope of ["write", "admin"] as const) {
    test(`${scope} key: preview works, says a person must confirm, and confirm is refused with the note untouched`, async () => {
      const old = mk("queue", "The queue is q1.");
      const neu = mk("queue now", "The queue is now q2.");
      const c = await connect(scope);
      const p: any = await c.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [old.id], new_id: neu.id } });
      const t = text(p);
      const body = JSON.parse(t.slice(t.indexOf("{")));
      assert.equal(body.confirm_by, "person");
      assert.doesNotMatch(body.warning, /call memory_replace/i, "the preview must not tell the agent to confirm");
      const done: any = await c.callTool({ name: "memory_supersede_confirm", arguments: { token: body.token } });
      assert.equal(done.isError, true, "confirm is refused");
      assert.match(text(done), /person/i);
      assert.notEqual(store.read(old.id)!.status, "superseded", "the old note is untouched");
      await c.close();
    });
  }

  test("the opt-out lets an admin MCP key confirm, so the test above is about the rule and not about a broken tool", async () => {
    process.env.MONOMEM_REPLACE_CONFIRM = "agent";
    const old = mk("queue", "The queue is q1.");
    const neu = mk("queue now", "The queue is now q2.");
    const c = await connect("admin");
    const p: any = await c.callTool({ name: "memory_supersede_preview", arguments: { old_ids: [old.id], new_id: neu.id } });
    const body = JSON.parse(text(p).slice(text(p).indexOf("{")));
    const done: any = await c.callTool({ name: "memory_supersede_confirm", arguments: { token: body.token } });
    assert.notEqual(done.isError, true, text(done));
    assert.equal(store.read(old.id)!.status, "superseded");
    await c.close();
  });
});

describe("the command line needs a terminal to confirm a code", () => {
  const mkIO = (interactive: boolean): { io: CliIO; out: string[] } => {
    const out: string[] = [];
    return { out, io: { out: (s) => out.push(s), err: (s) => out.push(s), interactive, ask: async () => "yes" } };
  };

  test("with no terminal the preview does not teach a scripted confirm, and --confirm-token is refused", async () => {
    const old = mk("cli host", "h1");
    const neu = mk("cli host now", "h2");
    const pv = mkIO(false);
    const code = await supersedeCli(store, ["--old", String(old.id), "--new-id", String(neu.id), "--json"], pv.io);
    assert.equal(code, 2);
    const printed = JSON.parse(pv.out.join("\n"));
    assert.doesNotMatch(printed.warning, /--confirm-token/, "no scripted path is offered under the person rule");
    const refused = mkIO(false);
    assert.equal(await supersedeCli(store, ["--confirm-token", printed.token], refused.io), 1, "exit code 1: refused");
    const said = refused.out.join("\n");
    assert.match(said, /terminal/i);
    assert.match(said, /speed bump/i);
    assert.notEqual(store.read(old.id)!.status, "superseded");
  });

  test("at a terminal the person still confirms by typing the number", async () => {
    const old = mk("cli host", "h1");
    const neu = mk("cli host now", "h2");
    const t = mkIO(true);
    const code = await supersedeCli(store, ["--old", String(old.id), "--new-id", String(neu.id)], t.io);
    assert.equal(code, 0, t.out.join("\n"));
    assert.equal(store.read(old.id)!.status, "superseded");
  });

  test("the opt-out keeps the old scripted flow for operators who want it", async () => {
    process.env.MONOMEM_REPLACE_CONFIRM = "agent";
    const old = mk("cli host", "h1");
    const neu = mk("cli host now", "h2");
    const pv = mkIO(false);
    await supersedeCli(store, ["--old", String(old.id), "--new-id", String(neu.id), "--json"], pv.io);
    const printed = JSON.parse(pv.out.join("\n"));
    assert.equal(await supersedeCli(store, ["--confirm-token", printed.token], mkIO(false).io), 0);
    assert.equal(store.read(old.id)!.status, "superseded");
  });
});
