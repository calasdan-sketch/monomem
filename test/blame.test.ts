// monomem blame / ask: who wrote a claim, and a deterministic retrieval timeline. Visibility is the scope matrix's job (scope-matrix.test.ts).
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { blame, askTimeline, renderBlame, renderTimeline, sinceIso } from "../src/blame.js";

const OWNER = { includeSuperseded: true, includeDistrusted: true, showHeld: true };
const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);

function fixture(): Store {
  const s = new Store(":memory:");
  const a = as("agent-a", () => s.create({ namespace: "p", title: "Deploy port is 8080", body: "The api deploy port is 8080 behind the proxy.", source: "chat" }));
  as("agent-b", () => s.update(a.id, { body: "The api deploy port is 8081 behind the proxy." }));
  as("agent-c", () => s.create({ namespace: "p", title: "Zebra notes", body: "zebra herd watering" }));
  return s;
}

describe("blame", () => {
  test("names the creator, the last writer, the versions and what changed it last", async () => {
    // Arrange
    const s = fixture();
    // Act
    const b = await blame(s, "deploy port", OWNER);
    // Assert
    assert.equal(b.rows.length, 1);
    const r = b.rows[0];
    assert.equal(r.created_by, "agent-a");
    assert.equal(r.written_by, "agent-b");
    assert.equal(r.versions, 2);
    assert.equal(r.state, "live");
    assert.equal(r.confirmed_by_person, null);
    assert.ok(r.last_change);
    assert.match(renderBlame(b, "deploy port"), /agent-a, last agent-b/);
    s.close();
  });

  test("says plainly when nothing matches", async () => {
    const s = fixture();
    assert.match(renderBlame(await blame(s, "quantum llama", OWNER), "quantum llama"), /No note matches/);
    s.close();
  });

  test("never prints the text of a held edit, with or without the admin view", async () => {
    const s = fixture();
    s.setApproveFirst("p", true);
    try {
      as("agent-d", () => s.update(1, { body: "HELDTEXT the port is 1" }));
    } catch {
      /* held */
    }
    const admin = JSON.stringify(await blame(s, "deploy port", OWNER));
    const plain = JSON.stringify(await blame(s, "deploy port", { ...OWNER, showHeld: false }));
    assert.doesNotMatch(admin, /HELDTEXT/);
    assert.doesNotMatch(plain, /HELDTEXT|held_edits/);
    s.close();
  });
});

describe("ask", () => {
  test("is labelled a retrieval timeline, not an answer, in text and json", async () => {
    const s = fixture();
    const t = await askTimeline(s, "port", OWNER);
    assert.equal(t.generated, false);
    assert.equal(t.kind, "retrieval-timeline");
    assert.match(renderTimeline(t, "port"), /not a generated answer/);
    s.close();
  });

  test("lists a replaced note with its replacement, newest first, with ids", async () => {
    const s = fixture();
    const old = s.list({ namespace: "p" }).notes.find((n) => n.title.startsWith("Deploy"))!;
    const nw = as("agent-c", () => s.create({ namespace: "p", title: "Deploy port is 9090", body: "The api deploy port moved to 9090." }));
    s.supersedeCommit({ oldIds: [old.id], oldRevs: [old.rev], newId: nw.id, actor: "agent-c", nonce: "t", expiresMs: Date.now() + 60_000 });
    const t = await askTimeline(s, "deploy port", OWNER);
    const lines = t.groups.flatMap((g) => g.lines);
    assert.equal(t.groups.length, 1, "replacement and replaced share one topic");
    assert.equal(lines[0].id, nw.id, "newest first");
    assert.match(lines.find((l) => l.id === old.id)!.state, new RegExp(`replaced by #${nw.id}`));
    s.close();
  });

  test("--since and --writer filter", async () => {
    const s = fixture();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal((await askTimeline(s, "port", OWNER, { since: future })).groups.length, 0);
    assert.equal((await askTimeline(s, "port", OWNER, { writer: "nobody" })).groups.length, 0);
    assert.equal((await askTimeline(s, "port", OWNER, { writer: "agent-b" })).groups.length, 1);
    s.close();
  });

  test("sinceIso reads windows and dates and rejects junk", () => {
    assert.equal(sinceIso("1d", 86_400_000 * 3), new Date(86_400_000 * 2).toISOString());
    assert.equal(sinceIso("2026-01-02"), "2026-01-02T00:00:00.000Z");
    assert.equal(sinceIso("soon"), null);
  });
});
