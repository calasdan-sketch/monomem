// B14 design system checks (.panel-160/expert-design.md): WCAG AA contrast for every text/background pair in both themes
// (placeholders included), nothing under 12 px, 44 px tap targets on phones, one action colour, red only for real danger,
// reduced motion and focus rings. Then the keyboard shortcuts and the first-run Welcome, in a stub browser.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { CSS } from "../src/ui/css.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2];
  return out;
}
const dark = tokens(CSS.slice(0, CSS.indexOf("@media (prefers-color-scheme:light)")));
const light = { ...dark, ...tokens(CSS.slice(CSS.indexOf("@media (prefers-color-scheme:light)"), CSS.indexOf("@media (max-width:600px){:root"))) };
function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** Placeholder: --text-2 at opacity .85 over the field background. */
function blend(fg: string, bg: string, alpha: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return "#" + [1, 3, 5].map((i) => Math.round(ch(fg, i) * alpha + ch(bg, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

describe("design system", () => {
  for (const [name, t] of [["dark", dark], ["light", light]] as const) {
    test(`${name}: every text pair passes WCAG AA (4.5:1), control edges and focus 3:1, placeholders included`, () => {
      const text: Array<[string, string]> = [
        ["text", "bg"], ["text", "surface"], ["text", "surface-2"], ["text-2", "bg"], ["text-2", "surface"], ["text-2", "surface-2"],
        ["action", "bg"], ["action", "surface"], ["on-action", "action"], ["destructive", "surface"], ["destructive", "bg"],
        ["on-destructive", "destructive-fill"], ["caution", "surface"], ["caution", "caution-bg"], ["text", "caution-bg"], ["positive", "surface"],
      ];
      for (const [f, b] of text) assert.ok(ratio(t[f], t[b]) >= 4.5, `${name} ${f} on ${b}: ${ratio(t[f], t[b]).toFixed(2)}`);
      for (const [f, b] of [["field", "surface"], ["field", "bg"], ["focus", "bg"], ["focus", "surface"]]) assert.ok(ratio(t[f], t[b]) >= 3, `${name} ${f} on ${b}: ${ratio(t[f], t[b]).toFixed(2)}`);
      const ph = blend(t["text-2"], t.surface, 0.85);
      assert.ok(ratio(ph, t.surface) >= 4.5, `${name} placeholder ${ratio(ph, t.surface).toFixed(2)}`);
    });
  }
  test("the navy header: white text, the search field and its placeholder pass on navy", () => {
    assert.ok(ratio("#FFFFFF", "#143C58") >= 4.5);
    assert.ok(ratio(blend("#A9BFCF", "#143C58", 0.85), "#143C58") >= 4.5);
    assert.match(CSS, /::placeholder\{color:var\(--text-2\);opacity:\.85\}/);
  });
  test("type scale: nothing under 12 px, in rem so text size settings scale it", () => {
    const sizes = [...(DASHBOARD_HTML + DASHBOARD_JS).matchAll(/font-size:([\d.]+)(px|rem|em)/g)].map((m) => (m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16));
    assert.ok(sizes.length > 10);
    assert.ok(sizes.every((s) => s >= 12), `smallest ${Math.min(...sizes)} px`);
    assert.ok(![...CSS.matchAll(/font-size:[\d.]+px/g)].length, "rem, not px");
    for (const px of [28, 20, 16, 14, 13, 12]) assert.ok(sizes.includes(px), `scale step ${px}`);
    assert.match(CSS, /body\{[^}]*font:400 0\.9375rem\//, "body text 15 px");
    assert.match(CSS, /body\{[^}]*font:400 0\.9375rem\//, "body text 15 px");
  });
  test("phones: 44 px tap targets; desktop 36; spacing on a 4 px grid", () => {
    assert.match(CSS, /--tap:36px/);
    assert.match(CSS, /@media \(max-width:600px\)\{:root\{--tap:44px\}\}/);
    assert.match(CSS, /button\{min-height:var\(--tap\)/);
    assert.match(CSS, /details\.menu>summary\{[^}]*width:var\(--tap\);height:var\(--tap\)/);
    for (const m of CSS.matchAll(/--s\d:(\d+)px/g)) assert.equal(Number(m[1]) % 4, 0);
  });
  test("one action colour; gold is the brand only; red only for delete, failures and the held stamp", () => {
    assert.match(CSS, /button\.primary\{background:var\(--action\)/);
    assert.ok(!/background:var\(--(gold|caution|brand)\)/.test(CSS), "no gold or caution filled buttons");
    for (const rule of CSS.split("}")) {
      if (!/var\(--destructive/.test(rule) || rule.includes(":root") || /^\s*--/.test(rule.split("{")[1] ?? "")) continue;
      const sel = rule.split("{")[0];
      assert.match(sel, /destructive|err|stamp|danger|del/, `red used on: ${sel.trim()}`);
    }
    assert.equal((DASHBOARD_HTML.match(/class="primary"/g) || []).length <= 5, true);
  });
  test("reduced motion, focus rings, light and dark", () => {
    assert.match(CSS, /prefers-reduced-motion:reduce\)\{\*\{animation:none!important/);
    assert.match(CSS, /:focus-visible\{outline:3px solid var\(--focus\)/);
    assert.match(CSS, /prefers-color-scheme:light/);
  });
  test("every form field has a visible label (placeholders are examples only)", () => {
    for (const id of ["n_title", "n_body", "n_ns", "n_tags", "n_lvl", "ns", "lvlf", "tok"]) {
      assert.match(DASHBOARD_HTML, new RegExp(`<label class="field"[^>]*><span>[^<]+</span><(input|textarea|select) id="${id}"`), id);
    }
  });
  test("plain words: no internal names or CLI hints where a button does the job", () => {
    const visible = DASHBOARD_HTML + DASHBOARD_JS.replace(/TYPE_WORDS = \{[^}]*\}/, "").replace(/=== "stale_twin"/g, ""); // identifiers, not words on screen
    for (const w of ["stale_twin", "quarantined write", "bearer token", "MONOMEM_TOKEN", "namespace</", ">primary<", "Remember:", "monomem supersede undo", "monomem quarantine"]) assert.ok(!visible.includes(w), w);
    assert.match(DASHBOARD_JS, /Save to Monomem: we deploy with pnpm/, "the Try it step uses the Save to Monomem wording");
  });
});

// ---- behaviour in a stub browser ----
function page(json: (path: string, method: string) => unknown) {
  const calls: string[] = [];
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) {
      const attrs = new Map<string, string>();
      els.set(id, { id, value: "", style: {}, textContent: "", innerHTML: "", hidden: false, open: false, checked: false, addEventListener() {}, focus() { ctx.document.activeElement = this; }, appendChild() {},
        showModal() { this.open = true; }, close() { this.open = false; }, getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) });
    }
    return els.get(id);
  };
  let keydown: (e: unknown) => void = () => {};
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }), addEventListener: (t: string, f: (e: unknown) => void) => { if (t === "keydown") keydown = f; }, activeElement: null, title: "" },
    sessionStorage: { getItem: (k: string) => (k === "om_tok" ? "tok" : ""), setItem() {}, removeItem() {} },
    navigator: {}, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, encodeURIComponent, Promise,
    fetch: async (path: string, o: any = {}) => (calls.push(`${o.method ?? "GET"} ${path}`), { ok: true, status: 200, json: async () => json(path, o.method ?? "GET") }),
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  const key = (k: string, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    keydown({ key: k, target: { tagName: "BODY" }, preventDefault: () => (prevented = true), ...extra });
    return prevented;
  };
  return { ctx, el, calls, key };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const ADMIN_ME = { scope: "admin", label: "primary" };

describe("keyboard shortcuts", () => {
  test("/ search, n new note, Ctrl+K and Cmd+K palette, ? help, u undo, 1-4 tabs; typing in a field is left alone", async () => {
    const p = page(() => ({ notes: [], count: 0, items: [] }));
    p.el("app").hidden = false;
    assert.ok(p.key("/"));
    assert.equal(p.ctx.document.activeElement?.id, "q");
    p.key("n");
    assert.equal(p.el("newsheet").open, true);
    p.el("newsheet").open = false;
    assert.ok(p.key("k", { ctrlKey: true }));
    assert.equal(p.el("palette").open, true);
    assert.match(p.el("pal_list").innerHTML, /Check for updates/);
    p.el("palette").open = false;
    p.key("k", { metaKey: true });
    assert.equal(p.el("palette").open, true);
    p.el("palette").open = false;
    p.key("?");
    assert.equal(p.el("helpsheet").open, true);
    p.el("helpsheet").open = false;
    let undone = 0;
    p.ctx.toast("Archived.", () => undone++);
    p.key("u");
    assert.equal(undone, 1);
    p.key("2");
    await settle();
    assert.ok(p.calls.some((c) => c.startsWith("GET /ui/review")));
    let typed = false;
    p.ctx.document.activeElement = null;
    typed = p.key("n", { target: { tagName: "INPUT" } });
    assert.equal(typed, false);
    assert.equal(p.el("newsheet").open, false);
    assert.match(DASHBOARD_HTML, /<dialog id="helpsheet"[\s\S]*<kbd>\/<\/kbd>[\s\S]*<kbd>n<\/kbd>[\s\S]*<kbd>u<\/kbd>[\s\S]*<kbd>\?<\/kbd>/);
  });
});

describe("Welcome (first run)", () => {
  test("the main key on a first run lands on Welcome; after Open my notes it is the dashboard from then on", async () => {
    let done = false;
    const p = page((path, m) => {
      if (path === "/whoami") return ADMIN_ME;
      if (path === "/ui/state") return { welcome_done: done, settings: { prompt_recall: "off", daily_backups: "on", declined_apps: [] }, version: "9.9.9" };
      if (path === "/ui/apps") return { apps: [{ id: "claude-code", label: "Claude Code", connected: false, declined: false }, { id: "cursor", label: "Cursor", connected: true, declined: false }] };
      if (path === "/ui/settings" && m === "PUT") { done = true; return { settings: {} }; }
      return { notes: [], count: 0, items: [] };
    });
    p.ctx.start();
    await settle();
    await settle();
    assert.equal(p.el("welcome").hidden, false);
    assert.equal(p.el("app").hidden, true);
    const w = p.el("welcome").innerHTML as string;
    assert.match(w, /Connect the apps you use/);
    assert.match(w, /Settings, then Undo the last connect, puts it back/);
    const apps = p.el("wl_apps").innerHTML as string;
    assert.match(apps, /<b>Claude Code<\/b>[\s\S]*connectApp\(&quot;claude-code&quot;\)'>Connect<[\s\S]*declineApp\(&quot;claude-code&quot;\)'>Not this one</);
    assert.match(apps, /<b>Cursor<\/b><div class='help'>In Cursor, open Settings, then MCP/);
    p.ctx.showWelcome(1);
    assert.match(p.el("welcome").innerHTML, /Save to Monomem: we deploy with pnpm/);
    assert.ok(!/Remember/.test(p.el("welcome").innerHTML));
    p.ctx.showWelcome(2);
    const consent = p.el("welcome").innerHTML as string;
    for (const s of ["Back up my notes every day", "Add matching notes to each prompt", "Start Monomem with my computer"]) assert.ok(consent.includes(s), s);
    assert.match(consent, /id='sw_recall' onchange/);
    assert.ok(!/id='sw_recall' checked/.test(consent), "prompt-time notes are off unless switched on");
    assert.match(consent, /You can close this window\. Your apps start Monomem themselves\./);
    p.ctx.finishWelcome();
    await settle();
    assert.ok(p.calls.includes("PUT /ui/settings"));
    assert.equal(p.el("app").hidden, false);
    const again = page((path) => (path === "/whoami" ? ADMIN_ME : path === "/ui/state" ? { welcome_done: true } : { notes: [], count: 0, items: [] }));
    again.ctx.start();
    await settle();
    await settle();
    assert.equal(again.el("welcome").hidden, true);
    assert.equal(again.el("app").hidden, false);
  });
  test("Settings: Update only asks github when pressed, and offers Update now only when a newer version exists", async () => {
    let out = "Monomem 1.6.0 is the newest version. Nothing to do.";
    const p = page((path) => (path === "/ui/update" ? { ok: true, code: 0, output: out } : path === "/ui/apps" ? { apps: [] } : {}));
    p.ctx.openSettings();
    assert.ok(!p.calls.some((c) => c.includes("/ui/update")), "opening Settings never checks");
    p.ctx.checkUpdate();
    await settle();
    assert.ok(!/doUpdate/.test(p.el("upd_out").innerHTML));
    out = "Monomem 1.6.1 is out (you have 1.6.0). Get it:  monomem update";
    p.ctx.checkUpdate();
    await settle();
    assert.match(p.el("upd_out").innerHTML, /onclick='doUpdate\(\)'>Update now</);
    assert.equal(p.calls.filter((c) => c === "POST /ui/update").length, 2);
  });
});
