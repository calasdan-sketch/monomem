// 1.4.0 (1a) re-confirmation expiry: off | label (default) | enforce, computed from the note's own times, never archives.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { injectContext, rankContext } from "../src/context-inject.js";
import { runSearch } from "../src/search-service.js";
import { setProcessWriter } from "../src/actor.js";

const noGit = { branch: "", diffFiles: [] };
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
afterEach(() => setProcessWriter(""));

/** Make a note look `days` old (written then, never confirmed). */
function age(s: Store, id: number, days: number): void {
  s.captureDb().prepare("UPDATE notes SET updated_at = ?, created_at = ? WHERE id = ?").run(ago(days), ago(days), id);
}
function setMetaRaw(s: Store, key: string, value: string): void {
  s.captureDb().prepare("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

describe("re-confirmation expiry", () => {
  test("defaults: label mode, 30 days", () => {
    const s = new Store(":memory:");
    const c = s.confirmSettings();
    assert.equal(c.mode, "label");
    assert.equal(c.days, 30);
    s.close();
  });

  test("label: an old note is flagged on reads and search, still in session start, never archived; pinned and fresh notes are not", async () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const old = s.create({ title: "old deploy guide", body: "run the pipeline zebra" });
    const fresh = s.create({ title: "fresh note", body: "zebra two" });
    const pinned = s.create({ title: "pinned rule", body: "zebra three" });
    age(s, old.id, 40);
    age(s, pinned.id, 40);
    s.captureDb().prepare("UPDATE notes SET pinned = 1 WHERE id = ?").run(pinned.id);
    const r = s.read(old.id)!;
    assert.equal(r.expired, true);
    assert.equal(r.expired_label, "[expired - not re-confirmed in 30 days]");
    assert.equal(s.read(fresh.id)!.expired, undefined);
    assert.equal(s.read(pinned.id)!.expired, undefined, "pinned notes are exempt");
    const hits = await runSearch(s, "zebra");
    assert.equal(hits.find((h) => h.id === old.id)?.expired, true);
    const pool = await rankContext(s, { signals: noGit });
    assert.ok(pool.ranked.some((n) => n.id === old.id), "label mode does not hide it");
    s.sweepExpired();
    assert.equal(s.read(old.id)!.archived_at, undefined, "never archived");
    s.close();
  });

  test("off: nothing is flagged and a confirm names no due date", () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    s.setConfirmSettings({ mode: "off" });
    const n = s.create({ title: "old", body: "b" });
    age(s, n.id, 400);
    assert.equal(s.read(n.id)!.expired, undefined);
    const r = s.confirm(n.id, { source: "checked" })!;
    assert.ok(!/Next check due/.test(r.message));
    s.close();
  });

  test("enforce: the clock starts at the switch; once past due, out of session start with a count line, still searchable", async () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const n = s.create({ title: "ZZ-OLD-TITLE", body: "quokka facts" });
    s.create({ title: "current guide", body: "quokka now" });
    age(s, n.id, 40);
    setProcessWriter("cli");
    s.setConfirmSettings({ mode: "enforce" });
    assert.equal(s.read(n.id)!.expired, undefined, "switching on does not expire old notes at once");
    setMetaRaw(s, "confirm_mode_set_at", ago(31));
    s.setConfirmSettings({}); // drops the one-second settings cache after the raw write
    assert.equal(s.read(n.id)!.expired, true);
    assert.equal(s.expiredCount(), 1);
    const ctx = await injectContext(s, { signals: noGit });
    assert.ok(!ctx.includes("ZZ-OLD-TITLE"));
    assert.match(ctx, /Monomem: 1 note not re-confirmed in 30 days \(not shown\)\. Review: monomem review/);
    const hits = await runSearch(s, "quokka");
    assert.ok(hits.some((h) => h.id === n.id && h.expired === true), "still returned, flagged");
    s.close();
  });

  test("a confirm restarts the clock and says when the next check is due; a re-confirm after expiry counts again", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const n = s.create({ title: "rates", body: "b" });
    age(s, n.id, 40);
    setProcessWriter("cli");
    const r = s.confirm(n.id, { source: "rate card" })!;
    assert.equal(r.counted, true);
    const due = new Date(Date.parse(r.at) + 30 * DAY).toISOString().slice(0, 10);
    assert.ok(r.message.endsWith(` Next check due ${due}.`), r.message);
    assert.equal(s.read(n.id)!.expired, undefined);
    // 40 days later: expired again, and the same person can confirm the same version again.
    s.captureDb().prepare("UPDATE notes SET confirmed_at = ? WHERE id = ?").run(ago(40), n.id);
    s.captureDb().prepare("UPDATE confirmations SET at = ? WHERE note_id = ?").run(ago(40), n.id);
    assert.equal(s.read(n.id)!.expired, true);
    const again = s.confirm(n.id, { source: "rate card" })!;
    assert.equal(again.counted, true, again.message);
    assert.equal(s.read(n.id)!.expired, undefined);
    s.close();
  });

  test("grandfathered notes count from the upgrade time", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const n = s.create({ title: "pre-upgrade", body: "b" });
    age(s, n.id, 400);
    s.captureDb().prepare("UPDATE notes SET grandfathered_at = ? WHERE id = ?").run(ago(5), n.id);
    assert.equal(s.read(n.id)!.expired, undefined);
    s.close();
  });

  test("settings: bad values refused; a mode change records when", () => {
    const s = new Store(":memory:");
    assert.throws(() => s.setConfirmSettings({ mode: "sometimes" as never }), /confirm-mode/);
    assert.throws(() => s.setConfirmSettings({ days: 0 }), /confirm-days/);
    s.setConfirmSettings({ days: 7 });
    assert.equal(s.confirmSettings().days, 7);
    assert.equal(s.confirmSettings().set_at, undefined, "days alone is not a mode switch");
    s.setConfirmSettings({ mode: "enforce" });
    assert.ok(s.confirmSettings().set_at);
    s.close();
  });

  test("CLI: config shows and raises without a gate, lowering is refused from a script; review lists; add --derived-from", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-expiry-cli-"));
    try {
      const db = join(dir, "state.db");
      new Store(db).close();
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
      const cli = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), ...args], { env, encoding: "utf8" });
      assert.match(cli("config").stdout, /confirm-mode: label \(default\)\s+confirm-days: 30/);
      const up = cli("config", "set", "confirm-mode", "enforce");
      assert.equal(up.status, 0, up.stderr);
      assert.match(up.stdout, /confirm-mode: enforce \(since/);
      const down = cli("config", "set", "confirm-mode", "off");
      assert.notEqual(down.status, 0);
      assert.match(down.stderr, /Refused/);
      assert.equal(cli("config", "set", "confirm-mode", "never").status, 1);
      assert.equal(cli("add", "first", "--outside").status, 0);
      const r = cli("review");
      assert.match(r.stdout, /1 note wait.*\n\s+#1 \[default\] first \(by cli\)\n\s+unconfirmed: from outside content/);
      const a = cli("add", "second", "--derived-from", "1");
      assert.equal(a.status, 0, a.stderr);
      const s = new Store(db);
      assert.deepEqual(s.read(2)!.derived_from, [1]);
      s.close();
      assert.match(cli("add", "third", "--derived-from", "77").stderr, /no note with id 77/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("review list: unconfirmed and expired notes with why and writer; rule lines for doctor", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio:bot");
    const out = s.create({ title: "vendor page", body: "b", outside: true });
    const old = s.create({ title: "old note", body: "b" });
    s.create({ title: "fine", body: "b" });
    age(s, old.id, 40);
    const list = s.reviewList();
    assert.deepEqual(list.map((r) => r.id).sort(), [out.id, old.id].sort());
    const u = list.find((r) => r.id === out.id)!;
    assert.match(u.why, /outside content/);
    assert.equal(u.writer, "stdio:bot");
    assert.match(list.find((r) => r.id === old.id)!.why, /not re-confirmed in 30 days/);
    const lines = s.confirmRuleLines().join("\n");
    assert.match(lines, /Unconfirmed notes.*: 1/);
    assert.match(lines, /expiry: label, every 30 days.*1 note/i);
    assert.match(lines, /window/i);
    assert.match(lines, /per connection; it resets when the server restarts/);
    s.close();
  });
});
