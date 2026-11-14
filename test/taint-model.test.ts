// 1.5.0 R1-04: taint follows the actor (the writer process's folder), not the namespace it names; every window has a visible end.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, needsHumanConfirm } from "../src/store.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import { setTtyCheck, unconfirmedCountLine, ReadTaint } from "../src/taint.js";
import { gradeOf } from "../src/health.js";

const WEB = "obs.origin:tool:WebFetch";
const ev = (sid: string, cwd: string, tool = "WebFetch", at = new Date()) =>
  normalizeHookInput("post-tool", { session_id: sid, cwd, tool_name: tool, tool_input: { url: "https://x.example" }, tool_response: "page" }, at);
/** A local stdio server launched in `cwd` (its writer label is a claim, not a token). */
const stdioAt = <T>(cwd: string, f: () => T, label = "stdio:cursor"): T => {
  setProcessWriter(label as "stdio:cursor");
  return actorStore.run({ label, cwd }, f);
};
const asToken = <T>(label: string, f: () => T, extra: Record<string, unknown> = {}): T => actorStore.run({ label, authed: true, ...extra }, f);
const HOUR = 3_600_000;

afterEach(() => {
  setProcessWriter("");
  setTtyCheck(undefined);
});

describe("R1-04 hook window follows the writer's folder", () => {
  test("1: a stdio server in the browsing session's folder is stamped even when it names another namespace", () => {
    const s = new Store(":memory:");
    recordEvent(s, ev("s1", "/p/a"), "default");
    const n = stdioAt("/p/a", () => s.create({ namespace: "scratch", title: "escape attempt", body: "b" }));
    assert.ok(n.tags.includes(WEB), n.tags.join());
    s.close();
  });

  test("2: a stdio server in another folder with its own clean session is not stamped", () => {
    const s = new Store(":memory:");
    recordEvent(s, ev("s1", "/p/a"), "default");
    recordEvent(s, ev("s2", "/p/b", "Read"), "default");
    const n = stdioAt("/p/b", () => s.create({ title: "other project", body: "b" }));
    assert.equal(n.unconfirmed, undefined);
    s.close();
  });

  test("3: a stdio server whose folder matches no session is stamped (unknown origin = worst case)", () => {
    const s = new Store(":memory:");
    recordEvent(s, ev("s1", "/p/a"), "default");
    const n = stdioAt("/x", () => s.create({ title: "from nowhere", body: "b" }));
    assert.ok(n.tags.includes(WEB));
    s.close();
  });

  test("4: a REST write token and the admin key are not stamped by the hook window", () => {
    const s = new Store(":memory:");
    recordEvent(s, ev("s1", "/p/a"), "default");
    const t = asToken("rest-app", () => s.create({ title: "token write", body: "b" }));
    const a = asToken("boss", () => s.create({ title: "admin write", body: "b" }), { canDeclassify: true });
    assert.equal(t.unconfirmed, undefined);
    assert.equal(a.unconfirmed, undefined);
    s.close();
  });

  test("5: a non-terminal cli write is stamped from any folder; a terminal cli write is not", () => {
    const s = new Store(":memory:");
    recordEvent(s, ev("s1", "/p/a"), "default");
    setProcessWriter("cli");
    setTtyCheck(() => false);
    assert.ok(s.create({ title: "from an agent shell", body: "b" }).tags.includes(WEB));
    setTtyCheck(() => true);
    assert.equal(s.create({ title: "from a person", body: "b" }).unconfirmed, undefined);
    s.close();
  });

  test("6: a session idle for 31 minutes no longer stamps", () => {
    const s = new Store(":memory:");
    recordEvent(s, ev("idle", "/p/a", "WebFetch", new Date(Date.now() - 31 * 60_000)), "default");
    const n = stdioAt("/p/a", () => s.create({ title: "late", body: "b" }));
    assert.equal(n.unconfirmed, undefined);
    s.close();
  });

  test("7: taint clear stops new stamps and never removes an old one; the CLI refuses without a terminal", () => {
    const s = new Store(":memory:");
    recordEvent(s, ev("s1", "/p/a"), "default");
    const before = stdioAt("/p/a", () => s.create({ title: "before", body: "b" }));
    assert.ok(before.tags.includes(WEB));
    assert.equal(s.taintClear({ cwd: "/p/a" }), 1);
    const after = stdioAt("/p/a", () => s.create({ title: "after", body: "b" }));
    assert.equal(after.unconfirmed, undefined);
    assert.ok(s.read(before.id)!.tags.includes(WEB), "the old stamp stays");
    s.close();
    const dir = mkdtempSync(join(tmpdir(), "om-taint-clear-"));
    try {
      const db = join(dir, "state.db");
      new Store(db).close();
      const r = spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "taint", "clear", "--all"], {
        env: { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db },
        encoding: "utf8",
        input: "",
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Refused/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R1-04 read-taint decays and ends with a confirm", () => {
  const unconfirmed = (s: Store) => {
    setProcessWriter("stdio:bot");
    return s.create({ title: "web page", body: "b", outside: true });
  };

  test("8a: once the note it read is confirmed, the token's next write is not via:memory", () => {
    const s = new Store(":memory:");
    const n = unconfirmed(s);
    const reads = new ReadTaint();
    reads.add(n.id);
    const w1 = asToken("tokA", () => s.create({ title: "w1", body: "b" }), { taintedReads: reads });
    assert.ok(w1.tags.includes("obs.origin:via:memory"));
    setProcessWriter("cli");
    s.confirm(n.id, { source: "checked" });
    const w2 = asToken("tokA", () => s.create({ title: "w2", body: "b" }), { taintedReads: reads });
    assert.equal(w2.unconfirmed, undefined);
    s.close();
  });

  test("8b: a read 13 hours ago no longer marks; read_it still refuses that token's confirm", () => {
    const s = new Store(":memory:");
    const n = unconfirmed(s);
    const reads = new ReadTaint();
    reads.set(n.id, Date.now() - 13 * HOUR);
    const w = asToken("tokA", () => s.create({ title: "w", body: "b" }), { taintedReads: reads });
    assert.equal(w.unconfirmed, undefined);
    const c = asToken("tokA", () => s.confirm(n.id, { source: "another source" }), { taintedReads: reads })!;
    assert.equal(c.reason, "read_it");
    s.close();
  });
});

describe("R1-04 retro-taint matches by folder and writer kind", () => {
  test("9: marks a stdio note from the same folder, not one from another folder, not a token's note", () => {
    const s = new Store(":memory:");
    const at = new Date(Date.now() - 60_000).toISOString();
    const same = stdioAt("/p/a", () => s.create({ title: "same folder", body: "b" }));
    const other = stdioAt("/p/b", () => s.create({ title: "other folder", body: "b" }));
    const tok = asToken("tokA", () => s.create({ title: "token note", body: "b" }));
    assert.equal(s.retroTaint("/p/a", at, "WebFetch"), 1);
    assert.ok(s.read(same.id)!.tags.includes(WEB));
    assert.equal(s.read(other.id)!.unconfirmed, undefined);
    assert.equal(s.read(tok.id)!.unconfirmed, undefined);
    s.close();
  });
});

describe("R1-04 visible, never silent", () => {
  test("10: the count line splits the cause; health is capped at B with a hidden backlog", () => {
    assert.equal(
      unconfirmedCountLine({ tool: 9, via: 2, declared: 0 }),
      "Monomem: 11 notes from outside content wait for confirmation (not shown): 9 written during a session that read the web, 2 written after reading unconfirmed notes. Review: monomem review"
    );
    assert.equal(unconfirmedCountLine({ tool: 0, via: 0, declared: 0 }), "");
    const s = new Store(":memory:");
    setProcessWriter("stdio:bot");
    for (let i = 0; i < 10; i++) s.create({ title: `n${i}`, body: "b", outside: true });
    const b = s.unconfirmedBreakdown();
    assert.deepEqual(b, { tool: 0, via: 0, declared: 10 });
    const lines = s.confirmRuleLines().join("\n");
    assert.match(lines, /10 .*declared/);
    assert.match(lines, /grade is capped at B/);
    assert.equal(gradeOf([{ id: "confirm-backlog", status: "warn" }]), "B");
    assert.equal(gradeOf([{ id: "confirm-backlog", status: "warn" }, { id: "x", status: "warn" }, { id: "y", status: "warn" }]), "C");
    assert.equal(gradeOf([{ id: "x", status: "ok" }]), "A");
    s.close();
  });

  test("a window open for this folder is named at session start with the way to close it", async () => {
    const s = new Store(":memory:");
    recordEvent(s, ev("s1", "/p/a", "WebFetch", new Date(Date.now() - 40 * 60_000 + 1000)), "default");
    // the session is 39 minutes old and idle: past the 30 minute idle limit, so no line; a fresh one gets the line
    recordEvent(s, ev("s2", "/p/c"), "default");
    const lines = s.openWindowLines("/p/c");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /a session in this folder read outside content \(WebFetch\)/);
    assert.match(lines[0], /monomem taint clear --here/);
    assert.equal(s.openWindowLines("/p/a").length, 0, "idle session: no window");
    s.close();
    assert.ok(needsHumanConfirm);
  });
});
