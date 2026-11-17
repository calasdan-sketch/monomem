// PLAN D: writer probation. A writer seen for the first time is labelled "new writer" and is not a second source until it has
// kept N notes for H hours or a person confirms it. Writers with notes before the upgrade are grandfathered.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { noteFlags } from "../src/taint.js";
import { factsTable } from "../src/facts.js";
import { confirmWriter, onProbation, probationList, setProbationSettings, NEW_WRITER_LABEL } from "../src/store/probation.js";

const as = <T>(label: string, fn: () => T): T => actorStore.run({ label, authed: true }, fn);

test("a new app key's notes show at once, labelled new writer; the person and the main key never are", () => {
  const s = new Store(":memory:");
  const n = as("newbot", () => s.create({ title: "deploy target", body: "we deploy to fly.io from main" }));
  assert.equal(s.read(n.id)!.new_writer, true);
  assert.match(noteFlags(s.read(n.id)!), /new writer/);
  const p = s.create({ title: "person note", body: "typed at the terminal" });
  assert.equal(s.read(p.id)!.new_writer, undefined);
  const m = as("primary", () => s.create({ title: "dashboard note", body: "from the owner's main key" }));
  assert.equal(s.read(m.id)!.new_writer, undefined);
  s.close();
});

test("a named stdio app is a writer too; plain stdio (no name) is not tracked", () => {
  const s = new Store(":memory:");
  const n = actorStore.run({ label: "" }, () => s.create({ title: "x", body: "y" }, { writtenBy: undefined }));
  assert.equal(s.read(n.id)!.new_writer, undefined);
  s.close();
});

test("writers that had notes before the upgrade are grandfathered; a writer seen later is on probation", () => {
  const s = new Store(":memory:");
  // writtenBy (an internal write for someone else) never records a writer: it stands in for notes written before 1.6.
  s.create({ title: "old", body: "written by codex in 1.5" }, { writtenBy: "codex" });
  const old = as("codex", () => s.create({ title: "codex again", body: "after the upgrade" }));
  assert.equal(s.read(old.id)!.new_writer, undefined, "codex had notes at upgrade: grandfathered");
  const fresh = as("newbot", () => s.create({ title: "hello", body: "first note from a new key" }));
  assert.equal(s.read(fresh.id)!.new_writer, true);
  assert.deepEqual(probationList(s).map((r) => [r.writer, r.state]), [["codex", "grandfathered"], ["newbot", "probation"]]);
  s.close();
});

test("a writer on probation is not a second source: its confirm does not count until a person confirms the writer", () => {
  const s = new Store(":memory:");
  s.create({ title: "old", body: "x" }, { writtenBy: "web-bot" });
  const web = as("web-bot", () => s.create({ title: "acme pricing", body: "pro plan is 40 dollars", outside: true }));
  as("newbot", () => s.create({ title: "hi", body: "new key" }));
  const r = as("newbot", () => s.confirm(web.id, { source: "https://acme.example/pricing" }))!;
  assert.equal(r.counted, false);
  assert.equal(r.reason, "new_writer");
  assert.ok(confirmWriter(s, "newbot", "cli"));
  assert.equal(onProbation(s, "newbot"), false);
  const again = as("newbot", () => s.confirm(web.id, { source: "https://acme.example/pricing" }))!;
  assert.equal(again.counted, true, again.message);
  assert.equal(confirmWriter(s, "nobody", "cli"), null);
  s.close();
});

test("a writer leaves probation after N notes kept H hours (not replaced, archived or flagged); probation-notes 0 turns it off", () => {
  const s = new Store(":memory:");
  const a = as("newbot", () => s.create({ title: "one", body: "first" }));
  const b = as("newbot", () => s.create({ title: "two", body: "second" }));
  setProbationSettings(s, { notes: 2, hours: 1 });
  assert.equal(onProbation(s, "newbot"), true, "notes too young");
  const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  s.db.prepare("UPDATE notes SET created_at = ? WHERE id IN (?, ?)").run(old, a.id, b.id);
  s.archive(b.id);
  setProbationSettings(s, { notes: 2 }); // clears the 1 s cache
  assert.equal(onProbation(s, "newbot"), true, "an archived note is not kept");
  s.restore(b.id);
  setProbationSettings(s, { notes: 2 });
  assert.equal(onProbation(s, "newbot"), false);
  const c = as("other", () => s.create({ title: "three", body: "third" }));
  assert.equal(s.read(c.id)!.new_writer, true);
  setProbationSettings(s, { notes: 0 });
  assert.equal(s.read(c.id)!.new_writer, undefined, "off");
  assert.throws(() => setProbationSettings(s, { hours: 0 }), /probation-hours/);
  s.close();
});

test("monomem facts does not count a writer on probation as agreeing", () => {
  const s = new Store(":memory:");
  s.create({ title: "old", body: "x" }, { writtenBy: "codex" });
  as("codex", () => s.create({ title: "pm", body: "we use pnpm", tags: ["fact:package_manager=pnpm"] }));
  as("newbot", () => s.create({ title: "pm too", body: "pnpm here", tags: ["fact:package_manager=pnpm"] }));
  const row = () => factsTable(s.list({ limit: 50 }).notes)["default"].find((r) => r.key === "package_manager")!;
  assert.equal(row().agreed, false);
  confirmWriter(s, "newbot", "cli");
  assert.equal(row().agreed, true);
  assert.ok(NEW_WRITER_LABEL.includes("new writer"));
  s.close();
});

test("session start names new writers once, in one line, and labels no note line with it", async () => {
  const { injectContext } = await import("../src/context-inject.js");
  const s = new Store(":memory:");
  for (let i = 0; i < 4; i++) as("newbot", () => s.create({ title: `note ${i}`, body: "some body text here" }));
  const out = await injectContext(s, { signals: { branch: "", diffFiles: [] }, tokens: 1500 });
  assert.equal(out.split("New writers, not a second source yet: newbot").length, 2, out);
  assert.ok(!out.split("\n").some((l) => /^#\d+/.test(l) && l.includes("[new writer]")), out);
  s.close();
});

test("F4 silent S1: a write that rolls back after making the probation table does not break every later write", () => {
  const s = new Store(":memory:");
  assert.throws(() =>
    s.transaction(() => {
      as("newbot", () => s.create({ title: "x", body: "made inside a transaction that fails" }));
      throw new Error("boom");
    }),
    /boom/
  );
  const n = as("otherbot", () => s.create({ title: "after", body: "the rollback took the table with it" }));
  assert.equal(s.read(n.id)!.new_writer, true, "the table is made again and the writer recorded");
  s.close();
});

test("F4 security S2: editing other writers' old notes does not end probation; only notes it created and kept count", () => {
  const s = new Store(":memory:");
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push(as("alice", () => s.create({ title: "old " + i, body: "alice text " + i })).id);
  s.db.prepare("UPDATE notes SET created_at = ?").run(new Date(Date.now() - 48 * 3_600_000).toISOString());
  as("newbot", () => s.create({ title: "hello", body: "first note" }));
  assert.equal(onProbation(s, "newbot"), true);
  for (const id of ids) as("newbot", () => s.update(id, { body: "edited by newbot " + id }));
  setProbationSettings(s, { notes: 5 }); // clears the 1 s cache
  assert.equal(onProbation(s, "newbot"), true, "five edits of old notes are not five kept notes");
  assert.equal(probationList(s).find((r) => r.writer === "newbot")!.kept, 0);
  assert.equal(onProbation(s, "alice"), false, "alice created and kept five notes for 48 hours");
  s.close();
});

test("F4 ease N2: an app the person connected with setup is not on probation; unknown apps and new app keys are", async () => {
  const { setProcessWriter } = await import("../src/actor.js");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "om-prob-setup-"));
  const change = (client: string) => ({ client, file: "x", real: "x", backup: null, createdFile: false, afterSha: "", inverse: [], label: client });
  writeFileSync(
    join(dir, "setup-history.json"),
    JSON.stringify([
      { id: "1", at: "2026-11-17T00:00:00Z", version: "1.6.0", changes: [change("project"), change("cursor"), change("shortcut")] },
      { id: "2", at: "2026-11-17T00:00:01Z", version: "1.6.0", undone: true, changes: [change("windsurf")] },
    ])
  );
  const s = new Store(join(dir, "state.db"));
  const w = (who: string) => {
    setProcessWriter(who as `stdio:${string}`);
    try {
      return s.create({ title: who, body: "a note from " + who });
    } finally {
      setProcessWriter("");
    }
  };
  try {
    assert.equal(s.read(w("stdio:claude-code").id)!.new_writer, undefined, "the project .mcp.json entry is Claude Code's");
    assert.equal(s.read(w("stdio:cursor").id)!.new_writer, undefined);
    assert.equal(s.read(w("stdio:windsurf").id)!.new_writer, true, "an undone setup does not count");
    assert.equal(s.read(w("stdio:unknownapp").id)!.new_writer, true);
    assert.equal(s.read(as("newbot", () => s.create({ title: "k", body: "app key" })).id)!.new_writer, true, "a new app key still starts on probation");
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
