// Round 3 design fixes (.panel-160/r3-design.md SF-1, SF-2, SF-4 and the LOW list; r3-ease-of-use.md S5), checked in a
// stub browser: Welcome switches keep their size, plain words instead of agent bracket labels, the launcher named per
// operating system, honest Welcome wording about secrets, one filled button per view, menu keys, and the small layout fixes.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSS } from "../src/ui/css.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";
import { DEFAULT_OPTIONS, runSetup, type SetupEnv, type SetupIO } from "../src/setup.js";

const UA = {
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

function page(json: (path: string, method: string) => unknown, ua = UA.win, status = 200) {
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) {
      const attrs = new Map<string, string>();
      els.set(id, { id, value: "", style: {}, textContent: "", innerHTML: "", hidden: false, open: false, checked: false, className: "", addEventListener() {}, focus() { ctx.document.activeElement = this; }, appendChild() {},
        showModal() { this.open = true; }, close() { this.open = false; }, getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) });
    }
    return els.get(id);
  };
  const handlers: Record<string, (e: unknown) => void> = {};
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }), addEventListener: (t: string, f: (e: unknown) => void) => { handlers[t] = f; }, activeElement: null, title: "", querySelectorAll: () => [] },
    sessionStorage: { getItem: (k: string) => (k === "om_tok" ? "tok" : ""), setItem() {}, removeItem() {} },
    navigator: { userAgent: ua }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, encodeURIComponent, Promise,
    fetch: async (path: string, o: any = {}) => ({ ok: status < 400, status, json: async () => json(path, o.method ?? "GET") }),
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, el, handlers };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const primaries = (html: string) => (html.match(/class='primary'/g) || []).length;

describe("SF-1: the Welcome switches", () => {
  test("the sign-in/Welcome card's full-width inputs leave checkboxes (the switches) alone", () => {
    assert.ok(!/\.gbody input\{/.test(CSS), "a bare .gbody input rule stretches the switches (same specificity as .switch input, and later)");
    assert.match(CSS, /\.gbody input:not\(\[type=checkbox\]\)\{width:100%\}/);
    // No rule after the switch rule may set an input width without excluding checkboxes.
    const after = CSS.slice(CSS.indexOf(".switch input{"));
    for (const rule of after.split("}").slice(1)) {
      const [sel, body = ""] = rule.split("{");
      if (/\binput\b/.test(sel) && /(^|;)width:/.test(body)) assert.match(sel, /not\(\[type=checkbox\]\)|\[type=checkbox\]|#|\.switch/, `rule "${sel.trim()}" sets an input width`);
    }
  });
});

describe("SF-2: plain words on the note card, never the agents' bracket labels", () => {
  test("labelsOf and the ... menu ignore *_label fields written for agents", () => {
    const p = page(() => ({}));
    const n = {
      id: 7, title: "T", tags: [], unconfirmed: true, unconfirmed_label: "[unconfirmed - from outside content]",
      built_on_distrusted: true, built_on_distrusted_label: "[built on a distrusted writer]", flagged: true, flagged_label: "[flagged by: cursor]",
      code_changed: true, code_changed_label: "[code changed since this was written: src/a.ts]", expired: true, expired_label: "[not re-confirmed in 30 days]",
      disputed: [{}], disputed_label: "disputed by a confirmed note", restated_by: ["x"], restated_label: "[echo of #2]",
    };
    const all = p.ctx.labelsOf(n).map((l: string[]) => l.join(" ")).join(" | ");
    assert.ok(!/\[|\]/.test(all), all);
    assert.match(all, /From outside content; nobody confirmed it yet/);
    assert.match(all, /Built on a distrusted note [A-Z]/, "a plain sentence, not an empty explanation");
    const menu = p.ctx.noteMenu(n);
    assert.ok(!/\[unconfirmed|\[built on|\[flagged|\[code changed|\[echo of/.test(menu), menu);
  });
});

describe("S5: Welcome says secrets are refused, injected instructions held", () => {
  test("the You're set step", () => {
    const p = page(() => ({}));
    p.ctx.showWelcome(2);
    const h = p.el("welcome").innerHTML as string;
    assert.match(h, /Writes that hold a secret are refused; writes that look like an injected instruction are held until you decide \(the Held tab\)\./);
    assert.ok(!/look like a secret or an injected instruction are held/.test(h));
  });
});

describe("SF-4: the launcher is named for this computer", () => {
  for (const [os, word] of [["win", "its Start menu entry"], ["mac", "your Applications folder"], ["linux", "your app launcher"]] as const) {
    test(`${os}: Welcome, the gate, a refused key and the local-sign-in messages say "${word}"`, async () => {
      const other = ["Start menu", "Applications folder", "app launcher"].filter((w) => !word.includes(w));
      const p = page(() => ({}), UA[os]);
      assert.equal(p.ctx.whereEntry(), word);
      assert.equal(p.el("gate_where").textContent, word, "the sign-in page is filled in at boot");
      p.ctx.showWelcome(2);
      const w = p.el("welcome").innerHTML as string;
      assert.ok(w.includes("open Monomem from " + word), w);
      const missing = page(() => ({ error: "local", local_required: true }), UA[os], 403);
      missing.ctx.loadApps2("set_apps", false);
      missing.ctx.loadSync();
      await settle();
      assert.ok(missing.el("set_apps").innerHTML.includes("open Monomem from " + word));
      assert.ok(missing.el("sync_now").textContent.includes("open Monomem from " + word));
      const refused = page(() => ({}), UA[os], 401);
      await refused.ctx.api("/notes").catch(() => {});
      assert.ok(refused.el("gate_err").textContent.includes("Open Monomem again from " + word));
      for (const o of other) assert.ok(!(w + missing.el("set_apps").innerHTML + refused.el("gate_err").textContent).includes(o), o);
    });
  }
  test("the static sign-in page has the slot the script fills", () => {
    assert.match(DASHBOARD_HTML, /<p>Open Monomem from <span id="gate_where">its Start menu entry<\/span>, or run <code>monomem open<\/code>/);
  });
});

describe("LOW: one filled button per view, labels that name where they go", () => {
  test("the Needs-you banner button names its destination and is not a second filled button next to New note", () => {
    const p = page(() => ({}));
    p.ctx.VIEW = "list";
    p.ctx.setNeeds({ count: 1, items: [{ view: "held", count: 1, text: "1 write is held." }] });
    assert.match(p.el("needs").innerHTML, /onclick='loadHeld\(\)'>Open Held</);
    assert.equal(primaries(p.el("needs").innerHTML), 0);
    p.ctx.setNeeds({ count: 1, items: [{ view: "review", count: 1, text: "1 note waits." }] });
    assert.match(p.el("needs").innerHTML, /onclick='loadReview\(\)'>Open Review</);
    p.ctx.setNeeds({ count: 1, items: [{ view: "settings", count: 1, text: "The last backup failed." }] });
    assert.match(p.el("needs").innerHTML, /onclick='openSettings\(\)'>Open Settings</);
  });
  test("Welcome step 1: Connect buttons are plain, Next is the one filled button", async () => {
    const p = page((path) => (path === "/ui/apps" ? { apps: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }] } : {}));
    p.ctx.showWelcome(0);
    await settle();
    const all = (p.el("welcome").innerHTML as string) + (p.el("wl_apps").innerHTML as string);
    assert.equal(primaries(all), 1, all);
    assert.match(all, /class='primary' onclick='showWelcome\(1\)'>Next</);
  });
  test("Review: the held banner's Open Held is not a filled button", async () => {
    const p = page((path) => (path === "/ui/review" ? { notes: [], flagged: [], code_changed: [], held_writes: 2, count: 0 } : { conflicts: [] }));
    p.ctx.loadReview();
    await settle();
    assert.match(p.el("list").innerHTML, /<button[^>]*onclick='loadHeld\(\)'>Open Held</);
    assert.ok(!/class='primary' onclick='loadHeld\(\)'/.test(p.el("list").innerHTML));
  });
});

describe("LOW: the note menu's keys", () => {
  function menu() {
    const items: any[] = [];
    const summary = { focus() { p.ctx.document.activeElement = summary; } };
    const d: any = { open: false, querySelectorAll: () => items, querySelector: () => summary };
    const mk = (n: string) => ({ n, closest: () => d, focus() { p.ctx.document.activeElement = this; } });
    items.push(mk("a"), mk("b"), mk("c"));
    (summary as any).closest = () => d;
    const p = page(() => ({}));
    const key = (k: string, target: unknown) => { let prevented = false; p.handlers.keydown({ key: k, target, preventDefault: () => (prevented = true) }); return prevented; };
    return { p, d, items, summary, key };
  }
  test("arrow keys move through the items (and wrap); Home and End; Esc closes and goes back to the ... button", () => {
    const m = menu();
    assert.ok(m.key("ArrowDown", m.summary));
    assert.equal(m.d.open, true);
    assert.equal(m.p.ctx.document.activeElement.n, "a");
    m.key("ArrowDown", m.items[0]);
    assert.equal(m.p.ctx.document.activeElement.n, "b");
    m.key("End", m.items[1]);
    assert.equal(m.p.ctx.document.activeElement.n, "c");
    m.key("ArrowDown", m.items[2]);
    assert.equal(m.p.ctx.document.activeElement.n, "a", "wraps");
    m.key("ArrowUp", m.items[0]);
    assert.equal(m.p.ctx.document.activeElement.n, "c");
    m.key("Home", m.items[2]);
    assert.equal(m.p.ctx.document.activeElement.n, "a");
    assert.ok(m.key("Escape", m.items[0]));
    assert.equal(m.d.open, false);
    assert.equal(m.p.ctx.document.activeElement, m.summary);
  });
  test("a click outside closes an open menu", () => {
    const p = page(() => ({}));
    const open: any = { open: true, contains: () => false };
    p.ctx.document.querySelectorAll = () => [open];
    p.handlers.click({ target: {} });
    assert.equal(open.open, false);
    const inside: any = { open: true, contains: () => true };
    p.ctx.document.querySelectorAll = () => [inside];
    p.handlers.click({ target: {} });
    assert.equal(inside.open, true, "a click inside the menu leaves it open");
  });
});

describe("LOW: small layout fixes", () => {
  test("disclosure links (More options, Use an app key instead) are at least 24 px tall", () => {
    assert.match(CSS, /\.gbody summary,\.sheet summary\{[^}]*padding:var\(--s2\) 0/);
  });
  test("Apps and keys: sentence case for no limit; every column has a name for the stacked phone layout", async () => {
    const p = page(() => ({ apps: [{ label: "boss", scope: "admin" }, { label: "env", scope: "write", source: "env" }] }));
    p.ctx.loadApps();
    await settle();
    const h = p.el("list").innerHTML as string;
    assert.match(h, /No limit \(sees everything\)/);
    assert.ok(!/<b>NO LIMIT<\/b>/.test(h));
    const heads = /<tr><th>App<\/th>([\s\S]*?)<\/tr>/.exec(h)![0];
    assert.ok(!/<th><\/th>/.test(heads), heads);
  });
  test("Usage before any session: only the empty card, not three zeros", async () => {
    const p = page(() => ({ meter: { totals: { sessions: 0 }, recent: [], db_bytes: 400000 } }));
    p.ctx.loadMeter();
    await settle();
    const h = p.el("list").innerHTML as string;
    assert.match(h, /Nothing measured yet/);
    assert.ok(!/class='stats'/.test(h), h);
    const later = page(() => ({ meter: { totals: { sessions: 2, injected_tokens: 10 }, recent: [], db_bytes: 400000 } }));
    later.ctx.loadMeter();
    await settle();
    assert.match(later.el("list").innerHTML, /class='stats'/);
  });
  test("Settings: Undo the last connect shows only when there is a connect to undo", async () => {
    for (const can of [false, true]) {
      const p = page((path) => (path === "/ui/apps" ? { apps: [], can_undo: can } : {}));
      p.ctx.openSettings();
      assert.match(p.el("set_body").innerHTML, /id='undo_row' hidden/, "hidden until the server says");
      await settle();
      assert.equal(p.el("undo_row").hidden, !can);
    }
  });
});

describe("LOW: setup's What I found table", () => {
  test("the status column never runs into the path", async () => {
    const root = mkdtempSync(join(tmpdir(), "om-r3-ui-setup-"));
    try {
      const home = join(root, "home");
      const e: SetupEnv = { home, platform: "linux", env: { HOME: home }, cwd: root, nodeVersion: "24.4.1", execPath: process.execPath, cliPath: "/opt/monomem/dist/src/cli.js", version: "2.0.0", now: () => new Date("2026-11-16T12:00:00Z") } as SetupEnv;
      const l: string[] = [];
      const io: SetupIO = { interactive: false, out: (x) => void l.push(x), err: (x) => void l.push(x), ask: async () => "" };
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(home, ".claude"), { recursive: true });
      await runSetup(e, io, { ...DEFAULT_OPTIONS, dryRun: true, noDoctor: true, noTestNote: true });
      const rows = l.join("\n").split("\n").filter((r) => /installed, no config file yet|  found /.test(r));
      assert.ok(rows.length, l.join("\n"));
      for (const r of rows) assert.match(r, /(installed, no config file yet|found)\s{2,}\S|(installed, no config file yet|found)$/, r);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
