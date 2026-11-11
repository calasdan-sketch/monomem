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
    assert.match(h, /aria-label='delete note #4'/);
    assert.match(h, /aria-label='never show note #4'/);
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
    assert.equal(p.el("viewh").textContent, "Held writes");
    assert.ok(p.el("viewd").textContent.length > 20);
    assert.match(DASHBOARD_HTML, /<h2 id="viewh"/);
  });
  test("+ New has aria-expanded and toggles it", () => {
    const p = page(() => ({}));
    assert.match(DASHBOARD_HTML, /id="btn_new" aria-expanded="false"/);
    p.ctx.toggleNew();
    assert.equal(p.el("btn_new").getAttribute("aria-expanded"), "true");
    p.ctx.toggleNew();
    assert.equal(p.el("btn_new").getAttribute("aria-expanded"), "false");
  });
  test("Quality tab shows a red count for fact disputes only, and the page says held, not quarantined", async () => {
    const groups = [{ tier: "fact", key: "k", values: [], namespace: "" }, { tier: "possible", key: "j", values: [], namespace: "" }];
    const p = page((path) => (path.startsWith("/quality") ? { counts: { quarantined: 2 }, issues: [], conflict_groups: groups, conflict_total: 2 } : { notes: [], quarantine: [] }));
    p.ctx.load();
    await settle();
    assert.match(p.el("quality_n").innerHTML, /1 disputed fact<\/span><span class='pill' aria-hidden='true'>1</);
    assert.equal(p.el("tab_quality").className, "lit");
    p.ctx.loadQuality();
    await settle();
    assert.equal(p.el("count").textContent, "2 held");
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
    assert.match(DASHBOARD_HTML, /header #q\{order:2;flex-basis:100%\}/);
    const header = DASHBOARD_HTML.slice(DASHBOARD_HTML.indexOf("<header"), DASHBOARD_HTML.indexOf("</header>"));
    assert.ok(!header.includes('id="inc"') && !header.includes('id="ns"'), "header holds only brand, search and + New");
    assert.match(DASHBOARD_HTML, /role="group" aria-label="Filters">[\s\S]*id="ns"[\s\S]*id="lvlf"[\s\S]*id="inc"/);
    assert.match(DASHBOARD_HTML, /<img src="\/favicon\.ico" alt=""/);
    assert.equal(FAVICON_PNG.readUInt32BE(16), FAVICON_PNG.readUInt32BE(20));
  });
  test("who-line: the owner sentence shows only for an unlimited admin key", async () => {
    const who = (w: unknown) => page((path) => (path === "/whoami" ? w : { notes: [] }));
    const admin = who({ label: "primary", scope: "admin" });
    admin.ctx.start();
    await settle();
    assert.match(admin.el("who").innerHTML, /^You're the owner: you can see everything\. Agents cannot change pinned notes; only you \(terminal or this owner key\) can pin or unpin\./);
    assert.match(admin.el("who").innerHTML, /<small class='tech'>primary<\/small>/);
    for (const w of [{ label: "phone", scope: "write", can_see: "public and internal notes." }, { label: "boss", scope: "admin", max_sensitivity: "internal", can_see: "x" }, { label: "ns", scope: "admin", namespace: "work", can_see: "x" }]) {
      const p = who(w);
      p.ctx.start();
      await settle();
      assert.ok(!/owner/.test(p.el("who").innerHTML + p.el("who").textContent), w.label);
      assert.match(p.el("who").textContent, /^Signed in as /);
    }
    const xss = who({ label: "<b>", scope: "admin" });
    xss.ctx.start();
    await settle();
    assert.ok(!xss.el("who").innerHTML.includes("<b>"));
  });
  test("the cli writer shows as terminal, with cli in small grey text", () => {
    const p = page(() => ({}));
    assert.match(p.ctx.chip("cli"), />terminal<small class='tech'>cli<\/small><\/span>$/);
    assert.ok(!/you/i.test(p.ctx.chip("cli")));
    assert.ok(!/tech/.test(p.ctx.chip("agent")));
  });
  test("delete asks for a permanent confirm; the per-note label picker uses the honest private wording", async () => {
    const p = page(() => ({ notes: [note] }));
    p.ctx.load();
    await settle();
    const h = p.el("list").innerHTML;
    assert.match(h, /data-confirm='Confirm permanent delete\?'[^>]*aria-label|aria-label='delete note #4' data-confirm='Confirm permanent delete\?'/);
    assert.match(h, />private \(limited apps cannot see it; unlimited apps still can\)</);
    const attrs: any = { "data-confirm": "Confirm permanent delete?" };
    const b: any = { textContent: "delete", _t: 0, getAttribute: (k: string) => attrs[k] ?? null, setAttribute: (k: string, v: string) => (attrs[k] = v), removeAttribute: (k: string) => delete attrs[k] };
    p.ctx.arm(b, () => {});
    assert.equal(b.textContent, "Confirm permanent delete?");
  });
  test("renamed labels: Usage, Activity log, backup, sign out, access key", () => {
    assert.match(DASHBOARD_HTML, /id="tab_meter"[^>]*>Usage<small class="tech">meter<\/small>/);
    assert.match(DASHBOARD_HTML, /id="tab_audit"[^>]*>Activity log<small class="tech">audit<\/small>/);
    assert.match(DASHBOARD_HTML, />Download backup<small class="tech">\.json<\/small>/);
    assert.match(DASHBOARD_HTML, /every note your key can see, unencrypted/);
    assert.match(DASHBOARD_HTML, />Add notes from a backup<small class="tech">\.json<\/small>/);
    assert.match(DASHBOARD_HTML, />Sign out</);
    assert.match(DASHBOARD_HTML, /placeholder="Your access key"/);
    assert.match(DASHBOARD_HTML, /MONOMEM_TOKEN/);
    assert.match(DASHBOARD_HTML, /\.token/);
    assert.equal((DASHBOARD_HTML.match(/by Calas Automations/g) || []).length, 2);
    assert.match(DASHBOARD_HTML, /Show notes from distrusted writers/);
    assert.ok(!/Export JSON|Import JSON|Change token/.test(DASHBOARD_HTML));
  });
});
