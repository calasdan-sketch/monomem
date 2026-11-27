// Round 4 a11y: one h1 per view, live announcer, landmarks, palette roles, held-card names, 100-at-a-time notes list, toast
// that waits for the pointer or focus, and the printable reports having a main landmark. Stub browser, no server.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";

function page(json: (path: string) => unknown) {
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) {
      const attrs = new Map<string, string>();
      els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, className: "", addEventListener() {}, focus() { (els as any).focused = id; },
        appendChild() {}, getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) });
    }
    return els.get(id);
  };
  const ctx: any = { document: { getElementById: el, createElement: () => ({ style: {} }) }, sessionStorage: { getItem: () => "tok", setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, encodeURIComponent, fetch: async (p: string) => ({ ok: true, status: 200, json: async () => json(p) }) };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, el, els };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, namespace: "w", title: "T" + i, body: "b", tags: [], written_by: "agent", updated_at: "2026-11-05T10:00:00Z", rev: 1 }));

describe("round 4 accessibility", () => {
  test("landmarks and headings: h1 view title, main on gate and welcome, live announcer", () => {
    assert.match(DASHBOARD_HTML, /<h1 id="viewh"/);
    assert.match(DASHBOARD_HTML, /id="gate" class="gate" role="main"/);
    assert.match(DASHBOARD_HTML, /id="welcome" class="welcome" role="main"/);
    assert.match(DASHBOARD_HTML, /id="announce" class="sr" role="status" aria-live="polite"/);
    assert.ok(!/<h3/.test(DASHBOARD_JS.replace(/<section><h3>/g, "")), "cards use h2 under the h1");
  });
  test("palette rows are options inside a listbox (li role none)", () => {
    const p = page(() => ({}));
    p.ctx.palFilter();
    assert.match(p.el("pal_list").innerHTML, /<li role='none'><button role='option'/);
  });
  test("held card: the Reject and distrust name starts with its visible words", async () => {
    const p = page((u) => u.startsWith("/quarantine") ? { quarantine: [{ id: 3, title: "x", written_by: "web-clipper", reasons: [], tags: [], created_at: "2026-11-05T10:00:00Z", namespace: "w" }] } : {});
    p.ctx.IS_ADMIN = true;
    p.ctx.loadHeld(); await settle();
    assert.match(p.el("list").innerHTML, /aria-label='Reject and distrust web-clipper \(held write #3\)'[^>]*>Reject and distrust web-clipper</);
    assert.match(p.el("list").innerHTML, /aria-label='reject held write #3'[^>]*>Reject</);
  });
  test("5,000 notes show 100 at a time, with a Show more button and a count that says so", async () => {
    const p = page(() => ({ notes: mk(5000) }));
    p.ctx.load(); await settle();
    const h = p.el("list").innerHTML;
    assert.equal((h.match(/<article class='card'/g) || []).length, 100);
    assert.match(h, /Show 100 more \(4900 not shown yet\)/);
    assert.equal(p.el("count").textContent, "Showing 100 of 5000 notes");
    p.ctx.moreNotes();
    assert.equal((p.el("list").innerHTML.match(/<article class='card'/g) || []).length, 200);
    assert.equal(p.el("count").textContent, "Showing 200 of 5000 notes");
  });
  test("a short list has no Show more button and the plain count", async () => {
    const p = page(() => ({ notes: mk(3) }));
    p.ctx.load(); await settle();
    assert.ok(!p.el("list").innerHTML.includes("morenotes"));
    assert.equal(p.el("count").textContent, "3 notes");
  });
  test("announce writes to the live region; an ended session says so in plain words", async () => {
    const p = page(() => ({}));
    p.ctx.announce("2 changes since you looked."); await new Promise((r) => setTimeout(r, 80));
    assert.equal(p.el("announce").textContent, "2 changes since you looked.");
    assert.match(DASHBOARD_JS, /Your session ended/);
  });
  test("printable reports have a main landmark", () => {
    for (const f of ["safety-report", "trust-report", "bench/html"]) {
      const s = fs.readFileSync(new URL(`../../src/${f}.ts`, import.meta.url), "utf8");
      assert.match(s, /<body><main>/, f);
      assert.match(s, /<\/main><\/body>/, f);
    }
  });
});
