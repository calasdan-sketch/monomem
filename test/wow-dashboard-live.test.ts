// The live dashboard (poll, held notification, reject-and-distrust, history diff): page script run in a stub browser.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";
import { DASHBOARD_CSP } from "../src/ui/csp.js";
import { LIVE_JS } from "../src/ui/js-live.js";

const XSS = `<img src=x onerror=alert(1)>`;
const SCRIPT = `</div><script>alert(2)</script>`;

function page(json: (path: string, method: string) => unknown, over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) {
      const attrs = new Map<string, string>();
      els.set(id, { value: "", hidden: false, style: {}, textContent: "", innerHTML: "", checked: false, addEventListener() {}, removeEventListener() {}, focus() {}, appendChild() {}, close() {},
        getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) });
    }
    return els.get(id);
  };
  const store = new Map<string, string>();
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }), hidden: false, addEventListener() {} },
    sessionStorage: { getItem: () => "tok", setItem() {}, removeItem() {} },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    setTimeout, clearTimeout, clearInterval: () => undefined, setInterval: () => 1, encodeURIComponent, addEventListener() {}, scrollY: 0,
    fetch: async (path: string, opts: any = {}) => {
      calls.push((opts.method ?? "GET") + " " + path);
      return { ok: true, status: 200, json: async () => json(path, opts.method ?? "GET") };
    },
    ...over,
  };
  ctx.window = ctx; // as in a browser
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, calls, el, state: { held: 1 } };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("live dashboard", () => {
  test("the script policy stays script-src 'self' and the live script adds no inline handler", () => {
    assert.ok(DASHBOARD_CSP.includes("script-src 'self';"));
    assert.ok(!/unsafe-inline[^;]*script|script-src[^;]*unsafe/.test(DASHBOARD_CSP));
    assert.ok(!/<[a-z][^>]*\son[a-z]+=/i.test(LIVE_JS), "inline handler built by the live script");
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(DASHBOARD_HTML));
    assert.match(DASHBOARD_HTML, /id="livebar"/);
  });

  test("the held count is summed from the needs-you items", () => {
    const p = page(() => ({}));
    const n = p.ctx.liveHeld({ items: [{ kind: "held", count: 2 }, { kind: "backup", count: 1 }, { kind: "held", count: 1 }] });
    assert.equal(n, 3);
    assert.equal(p.ctx.liveHeld(null), 0);
  });

  test("a new hold shows a notification with counts only, and only when the person opted in", async () => {
    const made: string[] = [];
    function N(this: unknown, t: string) { made.push(t); }
    (N as any).permission = "granted";
    const body = XSS + " attacker-host.example";
    const p = page((path) => (path === "/ui/needs-you" ? { count: 1, items: [{ kind: "held", count: p.state.held, view: "held", text: body }] } : { changes: [], until: "2026-01-01T00:00:00Z" }), { Notification: N });
    p.ctx.IS_ADMIN = true;
    await p.ctx.liveNeeds(); // baseline
    p.state.held = 2;
    await p.ctx.liveNeeds(); // not opted in
    assert.deepEqual(made, []);
    p.ctx.localStorage.setItem("om_notify", "1");
    p.state.held = 3;
    await p.ctx.liveNeeds();
    assert.equal(made.length, 1);
    assert.match(String(made[0]), /3 writes are held/);
    const text = String(made[0]);
    assert.ok(!text.includes("attacker") && !text.includes("<"), text);
  });

  test("the opt-in is offered only once something is held, and never after No thanks", async () => {
    const p = page((path) => (path === "/ui/needs-you" ? { count: 0, items: [] } : {}), { Notification: Object.assign(function () {}, { permission: "default" }) });
    p.ctx.IS_ADMIN = true;
    p.ctx.LIVE.heldN = 0;
    p.ctx.liveBar();
    assert.equal(p.el("livebar").hidden, true);
    p.ctx.LIVE.heldN = 1;
    p.ctx.liveBar();
    assert.match(p.el("livebar").innerHTML, /Notify me/);
    p.ctx.ACTS.liveNotifyNo();
    assert.equal(p.el("livebar").hidden, true);
  });

  test("the poll is off while the tab is hidden (no requests) unless notifications are on", async () => {
    const p = page(() => ({ count: 0, items: [] }));
    p.ctx.IS_ADMIN = true;
    await settle();
    p.calls.length = 0; // the page's own start-up requests
    p.ctx.document.hidden = true;
    p.ctx.liveTick();
    p.ctx.liveTick();
    await settle();
    assert.equal(p.calls.length, 0, p.calls.join());
    p.ctx.document.hidden = false;
    p.ctx.liveTick();
    await settle();
    assert.ok(p.calls.includes("GET /ui/needs-you"));
  });

  test("new changes show a count pill on Notes instead of redrawing under the cursor", async () => {
    let first = true;
    const p = page((path) => {
      if (!path.startsWith("/changes")) return { count: 0, items: [] };
      const r = first ? { changes: [], until: "2026-01-01T00:00:01Z" } : { changes: [{ kind: "created", id: 5, rev: 1, at: "2026-01-01T00:00:02Z" }], until: "2026-01-01T00:00:03Z" };
      first = false;
      return r;
    });
    p.ctx.IS_ADMIN = true;
    await p.ctx.liveChanges();
    await p.ctx.liveChanges();
    assert.equal(p.ctx.LIVE.newN, 1);
    assert.match(p.el("livebar").innerHTML, /1 change since you looked/);
    assert.ok(p.calls.some((c) => c.includes("/changes?since=2026-01-01T00%3A00%3A01Z")), p.calls.join());
  });

  test("the held card offers Reject and distrust (admin only), writer escaped, armed", async () => {
    const held = { id: 4, op: "create", namespace: "work", title: "t", body: "b", tags: [], written_by: "w" + XSS, reasons: [], created_at: "2026-11-05T10:00:00Z" };
    const p = page((path) => (path.startsWith("/quarantine") ? { quarantine: [held] } : {}));
    p.ctx.loadHeld();
    await settle();
    assert.ok(!/distrust/.test(p.el("list").innerHTML), "not for a non-admin");
    p.ctx.IS_ADMIN = true;
    p.ctx.loadHeld();
    await settle();
    const html = p.el("list").innerHTML as string;
    assert.match(html, /data-do='armHeldDistrust'/);
    assert.match(html, /Reject and distrust/);
    assert.ok(!html.includes("<img"), "no live markup");
  });

  test("reject and distrust rejects first, then distrusts the writer everywhere, and offers Undo", async () => {
    const p = page((path, m) => (path.startsWith("/trust/distrust") ? { matched_notes: 2 } : m === "POST" ? { rejected: 4 } : { quarantine: [] }));
    await settle();
    p.calls.length = 0;
    p.ctx.qHeldDistrust(4, "web-clipper");
    await settle();
    assert.deepEqual(p.calls.slice(0, 2), ["POST /quarantine/4/reject", "POST /trust/distrust"]);
    assert.match(p.el("toast").innerHTML, /distrusted: 2 notes are hidden/);
    assert.match(p.el("toast").innerHTML, /Undo/);
  });

  test("31-M8: if the distrust step fails after the reject, the toast says the write is gone and the writer is still trusted", async () => {
    const p = page(() => ({ quarantine: [] }), {
      fetch: async (path: string, opts: any = {}) =>
        path.startsWith("/trust/distrust") ? { ok: false, status: 500, json: async () => ({ error: "disk is full" }) } : { ok: true, status: 200, json: async () => (opts.method === "POST" ? { rejected: 4 } : { quarantine: [] }) },
    });
    await settle();
    p.ctx.qHeldDistrust(4, "web-clipper");
    await settle();
    assert.match(p.el("toast").innerHTML, /Rejected, but could not distrust web-clipper: disk is full. The write is gone; the writer is still trusted/);
  });

  test("31-M9: three failed polls say live updates are paused; a sign-out stops the timer", async () => {
    const p = page(() => ({}), { fetch: async () => ({ ok: false, status: 500, json: async () => ({ error: "down" }) }) });
    p.ctx.IS_ADMIN = true;
    for (let i = 0; i < 3; i++) {
      await p.ctx.liveNeeds().then(p.ctx.liveChanges).catch(p.ctx.liveFail);
    }
    assert.match(p.el("livebar").innerHTML, /Live updates paused/);
    p.ctx.LIVE.timer = 7;
    p.ctx.liveFail(new Error("not signed in"));
    assert.equal(p.ctx.LIVE.timer, 0);
  });

  test("history shows each diff escaped", async () => {
    const hist = { note_id: 1, current: { version: 3, written_by: "a" + XSS }, hidden_by_trust_policy: 1, versions: [{ version: 2, written_by: "x" + XSS, saved_at: "2026-11-05T10:00:00Z", saved_by: "y", reason: "update", diff: ["- " + SCRIPT, "+ " + XSS] }] };
    const p = page(() => hist);
    p.ctx.ACTS.noteHistory({}, [1]);
    await settle();
    const html = p.el("cf_body").innerHTML as string;
    assert.match(html, /class='del'/);
    assert.match(html, /class='add'/);
    assert.ok(!html.includes("<img") && !html.includes("<script"), html);
    assert.match(html, /1 version is hidden/);
  });

  test("the demo banner shows only for a demo store", () => {
    const p = page(() => ({}));
    p.ctx.demoBanner({ demo: false });
    assert.equal(p.el("demobar").hidden, false); // untouched default of the stub
    p.el("demobar").hidden = true;
    p.ctx.demoBanner({ demo: false });
    assert.equal(p.el("demobar").hidden, true);
    p.ctx.demoBanner({ demo: true });
    assert.equal(p.el("demobar").hidden, false);
    assert.match(p.el("demobar").innerHTML, /Demo store/);
  });
});
