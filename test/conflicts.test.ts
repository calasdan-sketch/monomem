// Conflict detector: two live notes from different writers that disagree about the same thing. Flags only.
import { slow } from "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { findConflicts } from "../src/conflicts.js";
import { qualityReport } from "../src/quality.js";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api.js";
import { DASHBOARD_JS } from "../src/dashboard.js";
import { buildFixture } from "./conflicts-fixture.js";

const mk = (s: Store, writer: string, title: string, body: string, ns = "default"): number => s.create({ title, body, namespace: ns }, { writtenBy: writer }).id;

describe("findConflicts rules", () => {
  test("same key, different value, different writers: flagged with both writers, values and key", () => {
    const s = new Store(":memory:");
    const a = mk(s, "alice", "Deploy target: Fly.io", "x");
    const b = mk(s, "bob", "Deploy target: Render", "y");
    const [c, ...rest] = findConflicts(s);
    assert.equal(rest.length, 0);
    assert.deepEqual([c.a.id, c.b.id], [a, b]);
    assert.deepEqual([c.a.writer, c.b.writer], ["alice", "bob"]);
    assert.equal(c.key, "deploy target");
    assert.deepEqual(c.values, ["fly.io", "render"]);
    assert.equal(c.confidence, "high");
    assert.ok(c.a.at && c.b.at);
    s.close();
  });
  test("use pnpm vs use npm is flagged; use pnpm for ci vs use npm for docs is not", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "Use pnpm", "z"); mk(s, "bob", "Use npm", "z");
    assert.equal(findConflicts(s).length, 1);
    const t = new Store(":memory:");
    mk(t, "alice", "Use pnpm for ci", "z"); mk(t, "bob", "Use npm for docs", "z");
    assert.equal(findConflicts(t).length, 0);
    s.close(); t.close();
  });
  test("not flagged: same writer, same value, other namespace, archived, or unrelated subjects sharing a key", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "Deploy target: Fly.io", "x"); mk(s, "alice", "Deploy target: Render", "x"); // one writer
    mk(s, "alice", "Region: eu", "x"); mk(s, "bob", "Region: eu", "x"); // agree
    mk(s, "alice", "Cache TTL: 5m", "x", "other"); mk(s, "bob", "Cache TTL: 1h", "x", "third"); // namespaces differ
    mk(s, "alice", "auth service runbook", "Port: 3000"); mk(s, "bob", "billing service runbook", "Port: 3001"); // unrelated
    const gone = mk(s, "alice", "Queue: sqs", "x"); mk(s, "bob", "Queue: rabbit", "x");
    s.archive(gone);
    assert.deepEqual(findConflicts(s), []);
    s.close();
  });
  test("only flags: no note is changed, hidden or merged", () => {
    const s = new Store(":memory:");
    const a = mk(s, "alice", "Deploy target: Fly.io", "x"); mk(s, "bob", "Deploy target: Render", "y");
    const before = JSON.stringify(s.exportAll());
    findConflicts(s);
    assert.equal(JSON.stringify(s.exportAll()), before);
    assert.equal(s.read(a)!.rev, 1);
    s.close();
  });
  test("namespace filter", () => {
    const s = new Store(":memory:");
    mk(s, "alice", "Deploy target: Fly.io", "x", "p"); mk(s, "bob", "Deploy target: Render", "y", "p");
    assert.equal(findConflicts(s, { namespaces: ["q"] }).length, 0);
    assert.equal(findConflicts(s, { namespaces: ["p"] }).length, 1);
    s.close();
  });
  test("quality report carries the conflicts", async () => {
    const s = new Store(":memory:");
    mk(s, "alice", "Deploy target: Fly.io", "x"); mk(s, "bob", "Deploy target: Render", "y");
    const r = await qualityReport(s);
    assert.equal(r.conflicts.length, 1);
    s.close();
  });
});

describe("surfaces", () => {
  test("GET /quality is admin only and carries the conflicts; the dashboard script renders and escapes them", async () => {
    const s = new Store(":memory:");
    mk(s, "alice", "Deploy target: Fly.io", "x"); mk(s, "bob", "Deploy target: Render", "y");
    const server = createApiServer(s, [{ token: "adm", scope: "admin", label: "op" }, { token: "rd", scope: "read", label: "reader" }]);
    await new Promise<void>((ok) => server.listen(0, ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await fetch(base + "/quality", { headers: { Authorization: "Bearer rd" } })).status, 403);
      const j = (await (await fetch(base + "/quality", { headers: { Authorization: "Bearer adm" } })).json()) as { conflicts: Array<{ key: string }> };
      assert.equal(j.conflicts[0].key, "deploy target");
    } finally {
      server.close();
      s.close();
    }
    assert.match(DASHBOARD_JS, /<h2 class='t-head'>Conflicts \(/);
    assert.match(DASHBOARD_JS, /esc\(v\.value\)/);
  });
});

describe("precision and recall on a ~200-note mixed store", () => {
  test("measured", () => {
    const { store, planted, missed } = buildFixture();
    const total = store.exportAll({ live: true }).length;
    const found = findConflicts(store);
    const key = (x: number, y: number): string => (x < y ? `${x}-${y}` : `${y}-${x}`);
    const truth = new Set([...planted, ...missed].map(([x, y]) => key(x, y)));
    const hit = found.filter((c) => truth.has(key(c.a.id, c.b.id)));
    const precision = found.length ? hit.length / found.length : 1;
    const recall = hit.length / truth.size;
    const high = found.filter((c) => c.confidence === "high");
    const highP = high.filter((c) => truth.has(key(c.a.id, c.b.id))).length / (high.length || 1);
    console.log(`conflicts fixture: notes=${total} planted=${truth.size} flagged=${found.length} tp=${hit.length} precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} high-precision=${highP.toFixed(2)}`);
    for (const c of found.filter((c) => !truth.has(key(c.a.id, c.b.id)))) console.log("FALSE POSITIVE", JSON.stringify(c));
    assert.ok(total >= 190, `fixture size ${total}`);
    assert.ok(precision >= 0.9, `precision ${precision}`);
    assert.ok(recall >= 0.75, `recall ${recall}`);
    store.close();
  });
});

test("a planted 250k-character line with a long whitespace run is skipped in milliseconds, not minutes", () => {
  const s = new Store(":memory:");
  mk(s, "alice", "x", "deploy: x" + " ".repeat(250_000) + "x");
  mk(s, "bob", "Deploy target: Render", "y");
  const t = Date.now();
  findConflicts(s);
  assert.ok(Date.now() - t < slow(500), `took ${Date.now() - t} ms`);
  s.close();
});
