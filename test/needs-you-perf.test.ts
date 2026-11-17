// r3 performance SF1: the dashboard asks GET /ui/needs-you after nearly every click. Its "disputed facts" count must not
// read (and, on an encrypted store, decrypt) every note: only notes that carry a fact: tag can be in a fact dispute.
// The count is reused while nothing in the database changed, and recomputed after any write.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { actorStore } from "../src/actor.js";
import { needsYou } from "../src/ui/needs-you.js";

const as = <T>(label: string, f: () => T): T => actorStore.run({ label, authed: true }, f);
const conflictsOf = (n: ReturnType<typeof needsYou>): number => n.items.find((i) => i.kind === "conflicts")?.count ?? 0;

test("needs-you counts fact disputes without reading every note", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-needs-perf-"));
  const s = new Store(":memory:");
  try {
    for (let i = 0; i < 50; i++) as("alice", () => s.create({ title: `plain note ${i}`, body: "no facts here" }, { skipEdges: true, lint: "none" }));
    as("alice", () => s.create({ title: "deploy", body: "x", tags: ["fact:deploy_target=fly"] }));
    as("bob", () => s.create({ title: "deploy 2", body: "y", tags: ["fact:deploy_target=render"] }));
    s.exportAll = () => {
      throw new Error("the badge read every note");
    };
    assert.equal(conflictsOf(needsYou(s, { dataDir: dir })), 1);
  } finally {
    s.close();
  }
});

test("needs-you reuses the dispute count until something is written, then counts again", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-needs-perf-"));
  const s = new Store(":memory:");
  try {
    as("alice", () => s.create({ title: "deploy", body: "x", tags: ["fact:deploy_target=fly"] }));
    as("bob", () => s.create({ title: "deploy 2", body: "y", tags: ["fact:deploy_target=render"] }));
    let reads = 0;
    const real = s.liveFactNotesIn.bind(s);
    s.liveFactNotesIn = (...a: Parameters<Store["liveFactNotesIn"]>) => (reads++, real(...a));
    assert.equal(conflictsOf(needsYou(s, { dataDir: dir })), 1);
    assert.equal(conflictsOf(needsYou(s, { dataDir: dir })), 1);
    assert.equal(reads, 1, "nothing changed: the second call reuses the count");
    as("alice", () => s.create({ title: "db", body: "x", tags: ["fact:database=postgres"] }));
    as("bob", () => s.create({ title: "db 2", body: "y", tags: ["fact:database=mysql"] }));
    assert.equal(conflictsOf(needsYou(s, { dataDir: dir })), 2, "a write invalidates the cached count");
    assert.equal(reads, 2);
    s.distrustAdd("*", "bob");
    assert.equal(conflictsOf(needsYou(s, { dataDir: dir })), 0, "distrusting a writer drops its side");
  } finally {
    s.close();
  }
});
