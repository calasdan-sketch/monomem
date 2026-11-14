// 1.4.0: an unconfirmed note is held out of session start (bodies AND titles); one count line says how many wait.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { injectContext, rankContext, newNotesSince } from "../src/context-inject.js";
import { runSearch } from "../src/search-service.js";
import { normalizeHookInput, recordEvent } from "../src/capture.js";
import { setProcessWriter } from "../src/actor.js";

const noGit = { branch: "", diffFiles: [] };
afterEach(() => setProcessWriter(""));

describe("unconfirmed notes at session start", () => {
  test("no title, no body, one count line; a confirm lets it back in", async () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    s.create({ title: "deploy guide", body: "run the pipeline" });
    const a = s.create({ title: "ZZ-TITLE-MARKER vendor page", body: "zz-poison-body", outside: true });
    s.create({ title: "second outside", body: "zz-poison-two", outside: true });
    const ctx = await injectContext(s, { signals: noGit });
    assert.match(ctx, /deploy guide/);
    assert.ok(!ctx.includes("ZZ-TITLE-MARKER"), "no title");
    assert.ok(!ctx.includes("zz-poison"), "no body");
    assert.match(ctx, /Monomem: 2 notes from outside content wait for confirmation \(not shown\)\. Review: monomem review/);
    const pool = await rankContext(s, { signals: noGit });
    assert.ok(!pool.ranked.some((n) => n.id === a.id));
    setProcessWriter("cli");
    s.confirm(a.id, { source: "checked" });
    const ctx2 = await injectContext(s, { signals: noGit });
    assert.match(ctx2, /Monomem: 1 note from outside content waits for confirmation/);
    assert.match(ctx2, /ZZ-TITLE-MARKER vendor page/, "confirmed: back in, as an index line");
    assert.ok(!ctx2.includes("zz-poison-body"), "a tainted note's text is never pasted, confirmed or not");
    s.close();
  });

  test("only unconfirmed notes: the count line alone; nothing at all when there are none", async () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    assert.equal(await injectContext(s, { signals: noGit }), "");
    s.create({ title: "x", outside: true });
    assert.equal(await injectContext(s, { signals: noGit }), "Monomem: 1 note from outside content waits for confirmation (not shown). Review: monomem review");
    s.close();
  });

  test("the per-prompt new-notes block leaves them out too", () => {
    const s = new Store(":memory:");
    recordEvent(s, normalizeHookInput("session-start", { session_id: "sess", cwd: "C:/w" }, new Date(Date.now() - 60_000)), "default");
    recordEvent(s, normalizeHookInput("user-prompt", { session_id: "sess", cwd: "C:/w", prompt: "hi" }, new Date(Date.now() - 30_000)), "default");
    setProcessWriter("stdio:other");
    s.create({ title: "fresh clean note" });
    s.create({ title: "fresh OUTSIDE title", outside: true });
    recordEvent(s, normalizeHookInput("user-prompt", { session_id: "sess", cwd: "C:/w", prompt: "next" }), "default");
    const block = newNotesSince(s, "sess");
    assert.match(block, /fresh clean note/);
    assert.ok(!block.includes("OUTSIDE"));
    s.close();
  });

  test("search: still returned, labelled, mildly demoted", async () => {
    const s = new Store(":memory:");
    setProcessWriter("stdio");
    const clean = s.create({ title: "acme pricing", body: "acme pricing is 40" });
    const out = s.create({ title: "acme pricing", body: "acme pricing is 40", outside: true });
    const hits = await runSearch(s, "acme pricing", {});
    assert.deepEqual(hits.map((h) => h.id), [clean.id, out.id], "equal text, the unconfirmed one newer: it still ranks second");
    assert.equal(hits[1].unconfirmed, true);
    assert.equal(hits[1].unconfirmed_label, "[unconfirmed - from outside content]");
    s.close();
  });
});
