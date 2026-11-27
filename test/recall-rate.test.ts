// The recall-rate line: sessions that started vs sessions where memory was shown or read, with the window and its limits.
import "./setup-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { recallRate, renderRecallRate } from "../src/recall-rate.js";

const NOW = Date.now();
const iso = (h: number): string => new Date(NOW - h * 3600_000).toISOString();

function fixture(): Store {
  const s = new Store(":memory:");
  const db = s.captureDb();
  const ses = db.prepare("INSERT INTO sessions (id, namespace, cwd, started_at, ended_at) VALUES (?, 'p', '', ?, ?)");
  ses.run("s1", iso(10), iso(9));
  ses.run("s2", iso(8), iso(7));
  ses.run("s3", iso(6), iso(5));
  ses.run("s4", iso(4), iso(3));
  const log = db.prepare("INSERT INTO access_log (at, writer, tool, namespaces, query, results) VALUES (?, ?, ?, '[]', '', 1)");
  log.run(iso(9.5), "stdio:claude-code", "state_search"); // during s1
  log.run(iso(6.5), "stdio:claude-code", "hook:recall"); // a hook, not an agent read
  log.run(iso(5.5), "cli", "state_search"); // the owner's shell
  log.run(iso(3.5), "laptop-agent", "state_read"); // during s4
  db.exec("CREATE TABLE IF NOT EXISTS memory_receipts (session_id TEXT NOT NULL, note_id INTEGER NOT NULL, namespace TEXT NOT NULL DEFAULT '', client TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, rank INTEGER NOT NULL, why TEXT NOT NULL DEFAULT '', tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, note_id))");
  for (const id of ["s1", "s2", "s3"]) db.prepare("INSERT INTO memory_receipts (session_id, note_id, at, rank) VALUES (?, 1, ?, 1)").run(id, iso(5));
  return s;
}

test("counts shown and read sessions against the sessions started, ignoring hook and shell reads", () => {
  const s = fixture();
  const r = recallRate(s, { sinceIso: iso(24), now: NOW });
  assert.deepEqual([r.started, r.shown, r.read, r.read_calls], [4, 3, 2, 2]);
  assert.match(renderRecallRate(r), /showed notes in 3 of 4 captured sessions; an agent memory read was logged during 2 of 4/);
  s.close();
});

test("cuts the window to the access-log retention and says so", () => {
  const s = fixture();
  const r = recallRate(s, { sinceIso: new Date(NOW - 90 * 86_400_000).toISOString(), now: NOW });
  assert.equal(r.cut_by_retention, true);
  assert.match(renderRecallRate(r), /cut to the 30 days the access log keeps/);
  s.close();
});

test("with no captured sessions it gives no rate, not 0 percent", () => {
  const s = new Store(":memory:");
  assert.match(renderRecallRate(recallRate(s, { sinceIso: iso(24), now: NOW })), /no sessions were captured, so there is no rate/);
  s.close();
});
