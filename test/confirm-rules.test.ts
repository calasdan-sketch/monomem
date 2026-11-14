// 1.4.0 confirm rules (Store.confirm): who counts, as what, and what is recorded but not counted.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store, needsHumanConfirm } from "../src/store.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { sourceKey } from "../src/taint.js";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiServer } from "../src/api.js";
import { createMcpServer, DEFAULT_TOOLS } from "../src/mcp-server-core.js";

const as = <T>(label: string, f: () => T, extra: Record<string, unknown> = {}): T => actorStore.run({ label, authed: true, ...extra }, f);
const rows = (s: Store, id: number) => s.captureDb().prepare("SELECT by, kind, reason, source_key FROM confirmations WHERE note_id = ? ORDER BY id").all(id) as Array<{ by: string; kind: string; reason: string; source_key: string }>;

function outsideNote(s: Store, by = "research-bot", source = "https://www.vendor.example/pricing") {
  return as(by, () => s.create({ title: "Acme pricing", body: "acme costs 40", source, outside: true }));
}

afterEach(() => setProcessWriter(""));

describe("confirm rules", () => {
  test("source keys: URL host without www, else trimmed lowercase text", () => {
    assert.equal(sourceKey("https://WWW.Vendor.example/a?b"), "vendor.example");
    assert.equal(sourceKey("  Called The Vendor "), "called the vendor");
  });

  test("human: the CLI always counts, releases the note and lifts the promotion block", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    assert.equal(n.unconfirmed, true);
    assert.ok(needsHumanConfirm(n));
    setProcessWriter("cli");
    const r = s.confirm(n.id, { source: "vendor site" })!;
    assert.equal(r.counted, true);
    assert.equal(r.kind, "human");
    assert.match(r.message, /^Confirmed "Acme pricing" by cli at \d{4}-\d\d-\d\d \d\d:\d\d\. Checked against: vendor site\. Next check due \d{4}-\d\d-\d\d\.$/);
    const after = s.read(n.id)!;
    assert.equal(after.unconfirmed, undefined);
    assert.equal(after.confirmed_kind, "human");
    assert.equal(after.confirmed_rev, after.rev);
    assert.ok(!needsHumanConfirm(after));
    s.close();
  });

  test("same writer is refused, with the rule named", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    const r = as("research-bot", () => s.confirm(n.id, { source: "somewhere else" }))!;
    assert.equal(r.counted, false);
    assert.equal(r.message, "Not counted: research-bot wrote this note, so it can't confirm it. A person or a different agent must confirm.");
    assert.equal(s.read(n.id)!.unconfirmed, true);
    assert.deepEqual(rows(s, n.id).map((x) => [x.kind, x.reason]), [["not_counted", "same_writer"]]);
    s.close();
  });

  test("stdio (and any unauthenticated writer) is recorded, not counted", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    setProcessWriter("stdio:cursor");
    const r = s.confirm(n.id, { source: "docs" })!;
    assert.equal(r.counted, false);
    assert.equal(r.reason, "unauthenticated");
    assert.equal(s.read(n.id)!.unconfirmed, true);
    assert.equal(rows(s, n.id)[0].by, "stdio:cursor");
    s.close();
  });

  test("a different token: same source key refused; different key counts as corroborated (session start only, not promotion)", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    const same = as("checker-bot", () => s.confirm(n.id, { source: "http://vendor.example/other-page" }))!;
    assert.equal(same.reason, "same_source");
    const none = as("checker-bot", () => s.confirm(n.id, {}))!;
    assert.equal(none.reason, "no_source");
    const ok = as("checker-bot", () => s.confirm(n.id, { source: "https://news.example/acme" }))!;
    assert.equal(ok.counted, true);
    assert.equal(ok.kind, "corroborated");
    const after = s.read(n.id)!;
    assert.equal(after.unconfirmed, undefined, "released from the session-start hold");
    assert.ok(needsHumanConfirm(after), "but still not promotable");
    // A third writer naming the source the corroboration used adds nothing.
    assert.equal(as("third-bot", () => s.confirm(n.id, { source: "news.example" }))!.reason, "same_source");
    s.close();
  });

  test("one qualifying confirm per writer per rev; a second is not recorded again", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    as("checker-bot", () => s.confirm(n.id, { source: "https://a.example" }));
    const again = as("checker-bot", () => s.confirm(n.id, { source: "https://b.example" }))!;
    assert.equal(again.counted, false);
    assert.equal(again.reason, "already");
    assert.equal(again.recorded, false);
    assert.equal(rows(s, n.id).length, 1);
    s.close();
  });

  test("an edit makes it unconfirmed again (bound to rev); the writer may confirm the new rev only if it did not write it", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    as("checker-bot", () => s.confirm(n.id, { source: "https://a.example" }));
    assert.equal(s.read(n.id)!.unconfirmed, undefined);
    as("research-bot", () => s.update(n.id, { body: "acme costs 45" }));
    assert.equal(s.read(n.id)!.unconfirmed, true, "the confirm was for the old text");
    assert.equal(as("checker-bot", () => s.confirm(n.id, { source: "https://a.example" }))!.counted, true, "a new rev takes a new confirm");
    s.close();
  });

  test("a connection that read the note while unconfirmed is refused", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    const r = as("checker-bot", () => s.confirm(n.id, { source: "https://a.example" }), { taintedReads: new Set([n.id]) })!;
    assert.equal(r.reason, "read_it");
    assert.equal(s.read(n.id)!.unconfirmed, true);
    s.close();
  });

  test("confirm-derived-refused: a writer with a note derived from the target is refused", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    const child = as("checker-bot", () => s.create({ title: "built on acme pricing" }));
    s.captureDb().prepare("INSERT INTO note_links (note_id, derived_from, added_at, added_by) VALUES (?, ?, ?, ?)").run(child.id, n.id, new Date().toISOString(), "checker-bot");
    assert.equal(as("checker-bot", () => s.confirm(n.id, { source: "https://a.example" }))!.reason, "derived");
    s.close();
  });

  test("admin (dashboard / admin REST): counts as admin without a source, not as human; same-writer still refused", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    const r = as("primary", () => s.confirm(n.id, { admin: true }))!;
    assert.equal(r.kind, "admin");
    assert.equal(s.read(n.id)!.unconfirmed, undefined);
    assert.ok(needsHumanConfirm(s.read(n.id)!));
    const own = outsideNote(s, "primary");
    assert.equal(as("primary", () => s.confirm(own.id, { admin: true }))!.reason, "same_writer");
    s.close();
  });

  test("a weaker confirm never overwrites a stronger one for the same rev", () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    setProcessWriter("cli");
    s.confirm(n.id, { source: "vendor site" });
    setProcessWriter("");
    as("checker-bot", () => s.confirm(n.id, { source: "https://b.example" }));
    assert.equal(s.read(n.id)!.confirmed_kind, "human");
    s.close();
  });

  test("confirms count in the flood guard", () => {
    process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "3";
    try {
      const s = new Store(":memory:");
      const n = outsideNote(s);
      as("spam-bot", () => {
        s.confirm(n.id, { source: "https://a.example" });
        s.confirm(n.id, { source: "https://b.example" });
        s.confirm(n.id, { source: "https://c.example" });
        assert.throws(() => s.confirm(n.id, { source: "https://d.example" }), /paused by the flood guard/);
      });
      s.close();
    } finally {
      process.env.MONOMEM_FLOOD_WRITES_PER_HOUR = "0";
    }
  });

  test("surfaces: REST needs write scope; MCP memory_confirm is opt-in and a stdio confirm does not count", async () => {
    const s = new Store(":memory:");
    const n = outsideNote(s);
    const tokens = [
      { token: "reader-token-eeeeeeeeeeeeeeeeeeeeeeee", scope: "read" as const, label: "reader" },
      { token: "checker-token-ffffffffffffffffffffffff", scope: "write" as const, label: "checker-bot" },
    ];
    const http = createApiServer(s, tokens);
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    const post = (tok: string, body: unknown) =>
      fetch(`${base}/notes/${n.id}/confirm`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      assert.equal((await post(tokens[0].token, { source: "x" })).status, 403);
      const r = (await (await post(tokens[1].token, { source: "https://news.example" })).json()) as any;
      assert.equal(r.counted, true);
      assert.equal(r.kind, "corroborated");
    } finally {
      await new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      });
    }
    assert.ok(!DEFAULT_TOOLS.includes("memory_confirm"));
    const m = outsideNote(s, "other-bot");
    setProcessWriter("stdio");
    const server = createMcpServer(s, "admin", { tools: "all" }, { local: true });
    const [c, t] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" });
    await Promise.all([client.connect(c), server.connect(t)]);
    const res: any = await client.callTool({ name: "memory_confirm", arguments: { id: m.id, source: "docs" } });
    const out = JSON.parse(res.content[0].text.slice(res.content[0].text.indexOf("{")));
    assert.equal(out.counted, false);
    assert.equal(out.reason, "unauthenticated");
    await client.close();
    s.close();
  });

  test("a missing note answers null", () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    assert.equal(s.confirm(999), null);
    s.close();
  });
});
