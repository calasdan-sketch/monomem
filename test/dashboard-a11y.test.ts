// Release polish: button labels, view headings, fact chips, dispute badge, "held" wording, meter wording. Stub browser, no server.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DASHBOARD_HTML, DASHBOARD_JS, FAVICON_PNG } from "../src/dashboard.js";

function page(json: (path: string) => unknown) {
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) {
      const attrs = new Map<string, string>();
      els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, className: "", addEventListener() {}, focus() {}, appendChild() {},
        getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) });
    }
    return els.get(id);
  };
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }) },
    sessionStorage: { getItem: () => "tok", setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, encodeURIComponent,
    fetch: async (path: string) => ({ ok: true, status: 200, json: async () => json(path) }),
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, el };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const note = { id: 4, namespace: "work", title: "T", body: "b", tags: ["fact:deploy_target=render", "plain"], written_by: "agent", updated_at: "2026-11-05T10:00:00Z", rev: 1 };

describe("dashboard polish", () => {
  test("notes: per-note button labels, fact chip, plain tag", async () => {
    const p = page(() => ({ notes: [note] }));
    p.ctx.load();
    await settle();
    const h = p.el("list").innerHTML;
    // B14: one "..." menu per card (no row of buttons); archive needs an admin key, so a plain key's menu has none.
    assert.match(h, /<details class='menu'><summary aria-label='More for note #4'/);
    assert.match(h, /aria-label='never show note #4'/);
    assert.ok(!/delete/i.test(h), "no permanent delete on a note card");
    assert.match(h, /<span class='tag fact'>deploy_target = render<\/span>/);
    assert.ok(!h.includes("fact:deploy_target"));
    assert.match(h, /<span class='tag'>plain<\/span>/);
  });
  test("fact chip escapes key and value", () => {
    const p = page(() => ({}));
    const h = p.ctx.tagChip("fact:<b>=<i>");
    assert.ok(!h.includes("<b>") && !h.includes("<i>"));
  });
  test("arm keeps the aria-label in step and restores it", () => {
    const p = page(() => ({}));
    const attrs: any = { "aria-label": "delete note #4" };
    const b: any = { textContent: "delete", _t: 0, getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => (attrs[k] = v), removeAttribute: (k: string) => delete attrs[k] };
    p.ctx.arm(b, () => {});
    assert.equal(attrs["aria-label"], "confirm delete note #4");
    p.ctx.arm(b, () => {});
    assert.equal(attrs["aria-label"], "delete note #4");
  });
  test("each view sets one h2 and a visible description", async () => {
    const p = page(() => ({ notes: [], quarantine: [], sessions: [] }));
    p.ctx.loadHeld();
    await settle();
    assert.equal(p.el("viewh").textContent, "Held");
    assert.ok(p.el("viewd").textContent.length > 20);
    assert.match(DASHBOARD_HTML, /<h2 id="viewh"/);
  });
  test("New note opens a sheet and keeps aria-expanded in step", () => {
    const p = page(() => ({}));
    p.el("newsheet").showModal = function (this: any) { this.open = true; };
    p.el("newsheet").close = function (this: any) { this.open = false; };
    assert.match(DASHBOARD_HTML, /id="btn_new" class="primary" aria-haspopup="dialog" aria-expanded="false"/);
    assert.match(DASHBOARD_HTML, /<dialog id="newsheet"/);
    p.ctx.toggleNew();
    assert.equal(p.el("btn_new").getAttribute("aria-expanded"), "true");
    p.ctx.toggleNew();
    assert.equal(p.el("btn_new").getAttribute("aria-expanded"), "false");
  });
  test("the Needs you count badges Review and Held (neutral badge, no red outline), and Tidy up says held, not quarantined", async () => {
    const needs = { count: 3, items: [{ kind: "held", count: 2, view: "held", text: "2 writes are held." }, { kind: "conflicts", count: 1, view: "review", text: "1 fact has two answers." }] };
    const p = page((path) => (path === "/ui/needs-you" ? needs : path.startsWith("/quality") ? { counts: { quarantined: 2, stale_twin: 0 }, issues: [], conflict_groups: [] } : { notes: [], quarantine: [] }));
    p.ctx.setNeeds(needs);
    assert.match(p.el("held_n").innerHTML, /<span class='badge' aria-hidden='true'>2<\/span><span class='sr'>, 2 writes waiting<\/span>/);
    assert.match(p.el("review_n").innerHTML, /<span class='badge' aria-hidden='true'>1<\/span>/);
    assert.ok(!/lit|danger|pill/.test(p.el("tab_held").className + p.el("held_n").innerHTML));
    assert.equal(p.el("needs").hidden, false, "one calm banner on Notes");
    assert.match(p.el("needs").innerHTML, /3 things need you/);
    p.ctx.loadQuality();
    await settle();
    assert.equal(p.el("count").textContent, "2 held");
    assert.equal(p.ctx.typeLabel("stale_twin"), "older copy");
  });
  test("meter: singular time, plain saved wording, (none) namespace", async () => {
    const m = { totals: { sessions: 1, injections: 1, injected_tokens: 10, saved_tokens: 5, llm_tokens: 0 }, recent: [{ updated_at: "2026-11-05T10:00:00Z", namespace: "", injected_tokens: 1, saved_tokens: 1, llm_tokens: 0 }], note: "n" };
    const p = page(() => ({ meter: m }));
    p.ctx.loadMeter();
    await settle();
    const h = p.el("list").innerHTML;
    assert.ok(h.includes("(1 time)") && !h.includes("1 times"));
    assert.ok(!h.includes("stood in for<br>") && h.includes("minus the tokens injected"));
    assert.ok(h.includes("(none)"));
  });
  test("phone: search gets its own row under the brand; the distrusted checkbox lives in the Filters row; favicon is a square PNG", () => {
    assert.match(DASHBOARD_HTML, /header\.top #q\{order:3;flex-basis:100%\}/);
    const header = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf("<header"), DASHBOARD_HTML.indexOf("</header>"));
    assert.ok(!header.includes('id="inc"') && !header.includes('id="ns"'), "header holds only brand, search, New note and Settings");
    assert.match(DASHBOARD_HTML, /role="group" aria-label="Filters">[\s\S]*id="ns"[\s\S]*id="lvlf"[\s\S]*id="inc"/);
    assert.match(DASHBOARD_HTML, /<img src="\/icon\.svg" alt=""/);
    assert.equal(FAVICON_PNG.readUInt32BE(16), FAVICON_PNG.readUInt32BE(20));
  });
  test("who-line: the main key gets no repeated owner sentence or 'primary' tag; a limited key is told what it can see", async () => {
    const who = (w: unknown) => page((path) => (path === "/whoami" ? w : path === "/ui/state" ? { welcome_done: true } : { notes: [], count: 0, items: [] }));
    const admin = who({ label: "primary", scope: "admin" });
    admin.ctx.start();
    await settle();
    assert.equal(admin.el("msg").textContent, "");
    assert.ok(!/You're the owner|>primary</.test(DASHBOARD_HTML + DASHBOARD_JS), "no owner sentence, no primary tag");
    for (const w of [{ label: "phone", scope: "write", can_see: "public and internal notes." }, { label: "boss", scope: "admin", max_sensitivity: "internal", can_see: "x" }, { label: "ns", scope: "admin", namespace: "work", can_see: "x" }]) {
      const p = who(w);
      p.ctx.start();
      await settle();
      assert.match(p.el("msg").textContent, /^Signed in as /, w.label);
    }
  });
  test("writers read in plain words: cli is terminal, primary is you (main key); no jargon suffixes", () => {
    const p = page(() => ({}));
    assert.match(p.ctx.chip("cli"), />terminal<\/span>$/);
    assert.match(p.ctx.chip("primary"), />you \(main key\)<\/span>$/);
    assert.ok(!/class=.tech/.test(DASHBOARD_HTML + DASHBOARD_JS), "no .tech suffixes anywhere");
  });
  test("a card archives with Undo (not a permanent delete); delete for good lives in Archived notes and asks twice; honest private wording", async () => {
    const calls: string[] = [];
    const p = page(() => ({ notes: [note] }));
    const realFetch = p.ctx.fetch;
    p.ctx.fetch = (path: string, o: any) => (calls.push(`${o?.method ?? "GET"} ${path}`), realFetch(path, o));
    vm.runInContext("IS_ADMIN = true", p.ctx);
    p.ctx.load();
    await settle();
    const h = p.el("list").innerHTML;
    assert.match(h, /aria-label='archive note #4' onclick='archiveNote\(4\)'>Archive</);
    assert.match(h, />Private \(hidden from apps you limited\)</);
    p.ctx.archiveNote(4);
    await settle();
    assert.ok(calls.includes("POST /notes/4/archive"));
    assert.match(p.el("toast").innerHTML, /Archived\.<\/span><button onclick='undoLast\(\)'>Undo<\/button>/);
    p.ctx.undoLast();
    await settle();
    assert.ok(calls.includes("POST /notes/4/restore"), "Undo restores the note");
    p.ctx.loadArchived();
    await settle();
    assert.match(p.el("list").innerHTML, /data-confirm='Delete for good\?' onclick='arm\(this,function\(\)\{del\(4\)\}\)'>Delete for good</);
  });
  test("4 tabs + a Settings sheet; Usage, Tidy up, Apps and keys, Activity log, backup and sign out live in Settings", () => {
    const tabs = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf('<nav class="tabs"'), DASHBOARD_HTML.indexOf("</nav>"));
    assert.deepEqual([...tabs.matchAll(/id="tab_(\w+)"/g)].map((m) => m[1]), ["list", "review", "held", "activity"]);
    assert.match(DASHBOARD_HTML, /<dialog id="settings"/);
    for (const t of ["Usage", "Tidy up", "Apps and keys", "Activity log", "Archived notes", "Back up now", "Check for updates", "Sign out", "every note this key can see, not encrypted"]) assert.ok(DASHBOARD_JS.includes(t), t);
    // The sign-in screen: one sentence first; the key paste is behind a disclosure and never names MONOMEM_TOKEN.
    assert.match(DASHBOARD_HTML, /<summary class="muted">Use an access key instead<\/summary>/);
    assert.ok(!/MONOMEM_TOKEN/.test(DASHBOARD_HTML));
    assert.equal((DASHBOARD_HTML.match(/by Calas Automations/g) || []).length, 2);
    assert.match(DASHBOARD_HTML, /Show notes from distrusted writers/);
    assert.ok(!/Export JSON|Import JSON|Change token/.test(DASHBOARD_HTML));
  });
});
