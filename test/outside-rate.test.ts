// outside-rate.ts: how often a captured session read outside content, counted from stored events (not from the mark).
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { recordEvent, normalizeHookInput } from "../src/capture.js";
import { outsideRate, renderOutsideRate, wilson } from "../src/outside-rate.js";
import { buildDigest, renderDigest } from "../src/digest.js";

function withStore(fn: (s: Store) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "outside-rate-"));
  const s = new Store(join(dir, "t.db"));
  return Promise.resolve(fn(s)).finally(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
}
const tool = (store: Store, sid: string, name: string, out = "x") =>
  recordEvent(store, normalizeHookInput("post-tool", { session_id: sid, cwd: "/w", tool_name: name, tool_input: {}, tool_response: out }), "ns");

describe("outsideRate", () => {
  test("counts sessions by the rule, not by the mark", () =>
    withStore((s) => {
      tool(s, "a", "WebFetch");
      tool(s, "a", "Read");
      tool(s, "b", "Read");
      tool(s, "c", "mcp__other__thing");
      tool(s, "d", "mcp__monomem__memory_search");
      s.captureDb().prepare("UPDATE sessions SET outside_at = NULL").run(); // marks gone: the count must not change
      const r = outsideRate(s)!;
      assert.equal(r.sessions, 4);
      assert.equal(r.outside, 2);
    }));

  test("a session with only prompts is not in the denominator (it cannot read anything outside)", () =>
    withStore((s) => {
      recordEvent(s, normalizeHookInput("user-prompt", { session_id: "p", prompt: "hi" }), "ns");
      tool(s, "a", "WebFetch");
      tool(s, "b", "Read");
      const r = outsideRate(s)!;
      assert.equal(r.sessions, 2);
      assert.equal(r.allSessions, 3);
      assert.match(renderOutsideRate(r), /of all 3 captured sessions/);
    }));

  test("an outside tool with no output does not count (same as the live rule)", () =>
    withStore((s) => {
      tool(s, "a", "WebFetch", "");
      assert.equal(outsideRate(s)!.outside, 0);
    }));

  test("no events: null and a plain sentence, never a made-up zero", () =>
    withStore((s) => {
      assert.equal(outsideRate(s), null);
      assert.match(renderOutsideRate(null), /nothing to count/);
    }));

  test("the interval is honest for a small sample", () => {
    const w = wilson(6, 96);
    assert.ok(w.low > 2.5 && w.low < 3.5 && w.high > 12 && w.high < 13.5, `${w.low} ${w.high}`);
    assert.deepEqual(wilson(0, 0), { low: 0, high: 0 });
  });

  test("the line says what is not counted and flags a thin sample", () =>
    withStore((s) => {
      tool(s, "a", "WebFetch");
      const line = renderOutsideRate(outsideRate(s));
      assert.match(line, /1 of 1 sessions that ran tools/);
      assert.match(line, /too few sessions/i);
      assert.match(line, /Local file reads and shell fetches are not counted/);
    }));

  test("the digest carries the line", () =>
    withStore(async (s) => {
      tool(s, "a", "WebSearch");
      const d = await buildDigest(s, "24h");
      assert.equal(d.outsideReads?.outside, 1);
      assert.match(renderDigest(d), /Outside reads since/);
    }));
});
