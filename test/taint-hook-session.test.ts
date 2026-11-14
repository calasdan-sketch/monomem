// 1.4.0 taint, signal 1 (hooks): a hook-equipped session that read outside content marks notes written in its namespace.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { normalizeHookInput, recordEvent, spoolEvent, drainSpool, type HookEvent } from "../src/capture.js";
import { setProcessWriter } from "../src/actor.js";
import { setTtyCheck } from "../src/taint.js";

const fetchEv = (sid: string, at = new Date(), tool = "WebFetch", ev: HookEvent = "post-tool") =>
  normalizeHookInput(ev, { session_id: sid, cwd: "C:/w", tool_name: tool, tool_input: { url: "https://x.example" }, tool_response: "page text" }, at);

afterEach(() => {
  setProcessWriter("");
  setTtyCheck(undefined);
  delete process.env.MONOMEM_TAINT_WINDOW_HOURS;
});

describe("taint from a hook session", () => {
  test("a WebFetch in the namespace marks the next stdio write; the mark survives an update that drops it", () => {
    const s = new Store(":memory:");
    recordEvent(s, fetchEv("web"), "default");
    setProcessWriter("stdio");
    const n = s.create({ title: "vendor pricing", body: "the page says $40" });
    assert.ok(n.tags.includes("obs.origin:tool:WebFetch"), n.tags.join());
    assert.equal(n.unconfirmed, true);
    assert.equal(n.unconfirmed_label, "[unconfirmed - from outside content]");
    const after = s.update(n.id, { tags: ["pricing"] });
    assert.ok(after!.tags.includes("obs.origin:tool:WebFetch"));
    assert.ok(after!.tags.includes("pricing"));
    s.close();
  });

  test("an edit by such a writer marks an existing clean note", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const n = s.create({ title: "clean", body: "before" });
    assert.equal(n.unconfirmed, undefined);
    recordEvent(s, fetchEv("web"), "default");
    const e = s.update(n.id, { body: "after reading the page" });
    assert.ok(e!.tags.includes("obs.origin:tool:WebFetch"));
    s.close();
  });

  test("no mark: other namespace, ended session, outside the window, local-only tool, the CLI", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    recordEvent(s, fetchEv("other-ns"), "elsewhere");
    assert.equal(s.create({ title: "a" }).unconfirmed, undefined, "other namespace");
    recordEvent(s, fetchEv("ended"), "default");
    recordEvent(s, normalizeHookInput("session-end", { session_id: "ended", cwd: "C:/w" }), "default");
    assert.equal(s.create({ title: "b" }).unconfirmed, undefined, "ended session");
    recordEvent(s, fetchEv("old", new Date(Date.now() - 13 * 3_600_000)), "default");
    assert.equal(s.create({ title: "c" }).unconfirmed, undefined, "older than 12 hours");
    recordEvent(s, fetchEv("local", new Date(), "Read"), "default");
    assert.equal(s.create({ title: "d" }).unconfirmed, undefined, "Read is not outside content");
    recordEvent(s, fetchEv("web"), "default");
    setProcessWriter("cli");
    setTtyCheck(() => true); // a person at a terminal (1.4.0: from an agent's shell the CLI is marked like any writer)
    assert.equal(s.create({ title: "e" }).unconfirmed, undefined, "the operator's own write");
    s.close();
  });

  test("MONOMEM_TAINT_WINDOW_HOURS widens or turns off the window", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    recordEvent(s, fetchEv("old", new Date(Date.now() - 13 * 3_600_000)), "default");
    process.env.MONOMEM_TAINT_WINDOW_HOURS = "24";
    assert.equal(s.create({ title: "inside 24h" }).unconfirmed, true);
    process.env.MONOMEM_TAINT_WINDOW_HOURS = "0";
    assert.equal(s.create({ title: "off" }).unconfirmed, undefined);
    s.close();
  });

  test("an unsafe tool name is stamped as other; another MCP server counts", () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    recordEvent(s, fetchEv("m", new Date(), "mcp__github__get_issue"), "default");
    assert.ok(s.create({ title: "issue" }).tags.includes("obs.origin:tool:mcp__github__get_issue"));
    s.close();
  });
});

describe("taint-spool-retro", () => {
  test("a spooled outside event drained later marks notes written after it", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-spool-"));
    try {
      const s = new Store(":memory:");
      const at = new Date(Date.now() - 60_000);
      // The hook could not open the database: the event went to the spool.
      assert.ok(spoolEvent(dir, { ...fetchEv("late", at), namespace: "default" }));
      setProcessWriter("stdio");
      const n = s.create({ title: "written meanwhile", body: "from the page" });
      assert.equal(n.unconfirmed, undefined, "not seen yet");
      setProcessWriter("");
      assert.equal(drainSpool(s, dir), 1);
      const after = s.read(n.id)!;
      assert.ok(after.tags.includes("obs.origin:tool:WebFetch"), after.tags.join());
      assert.equal(after.unconfirmed, true);
      assert.equal(after.rev, n.rev, "no rev bump: the content did not change");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
