// The dashboard has no inline event handlers, so its script policy needs no 'unsafe-inline'. Every button the page can
// build names an action in the dispatcher table; the click dispatcher runs only names in that table.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { DASHBOARD_JS, DASHBOARD_HTML } from "../src/dashboard.js";
import { DASHBOARD_CSP } from "../src/ui/csp.js";

test("the script policy has no unsafe-inline, and the page has no inline handler attributes", () => {
  const script = DASHBOARD_CSP.split(";").map((s) => s.trim()).find((s) => s.startsWith("script-src")) ?? "";
  assert.equal(script, "script-src 'self'");
  const handler = /[\s"'`]on[a-z]+\s*=/i; // any on...= attribute (onclick, onchange, onclose, ...)
  assert.ok(!handler.test(DASHBOARD_HTML), "inline handler in the page");
  assert.ok(!/<script(?![^>]*\ssrc=)/i.test(DASHBOARD_HTML), "inline script block in the page");
  assert.ok(!/javascript:/i.test(DASHBOARD_HTML + DASHBOARD_JS), "javascript: URL");
  // every on...= attribute written inside the script's HTML strings is gone (property assignments like el.onclick = fn are fine)
  assert.ok(!/<[a-z][^>]*\son[a-z]+=/i.test(DASHBOARD_JS), "inline handler built by the script");
});

test("every action name used in markup is in the dispatcher table", () => {
  const ctx: Record<string, unknown> = {};
  const noop = () => {};
  const el = () => ({ value: "", style: {}, addEventListener: noop, setAttribute: noop, getAttribute: () => null, appendChild: noop, focus: noop, classList: { add: noop, remove: noop } });
  Object.assign(ctx, { document: { getElementById: el, addEventListener: noop, querySelector: el, querySelectorAll: () => [], createElement: el, body: el(), documentElement: el() }, window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) }, navigator: {}, location: { hash: "" }, history: {}, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop }, localStorage: { getItem: () => null, setItem: noop }, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0 });
  vm.createContext(ctx);
  try { vm.runInContext(DASHBOARD_JS, ctx); } catch { /* boot code may need a fuller page; the table is defined before it runs */ }
  const acts = vm.runInContext("typeof ACTS === 'object' ? Object.keys(ACTS) : []", ctx) as string[];
  assert.ok(acts.length > 40, "the ACTS table exists");
  const used = new Set<string>();
  for (const m of (DASHBOARD_HTML + DASHBOARD_JS).matchAll(/data-(?:do|chg|enter|sub)=["']([A-Za-z]+)["']/g)) used.add(m[1]);
  for (const m of DASHBOARD_JS.matchAll(/act[AC]\("([A-Za-z]+)"/g)) used.add(m[1]);
  // names chosen at run time: the needs-you button, the tab views
  for (const n of ["loadHeld", "loadReview", "openSettings", "load", "loadChanges"]) used.add(n);
  const missing = [...used].filter((n) => !acts.includes(n));
  assert.deepEqual(missing, []);
  assert.ok(used.size >= 50, `only ${used.size} action names found`);
});

test("the dispatcher runs listed names and ignores everything else", () => {
  const ctx: Record<string, unknown> = {};
  const noop = () => {};
  const all: Record<string, ((e: unknown) => void)[]> = {};
  const el = () => ({ value: "", style: {}, addEventListener: noop, setAttribute: noop, getAttribute: () => null, appendChild: noop, focus: noop });
  Object.assign(ctx, { document: { getElementById: el, addEventListener: (t: string, f: (e: unknown) => void) => { (all[t] ??= []).push(f); }, querySelector: el, querySelectorAll: () => [], createElement: el }, window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) }, navigator: {}, location: { hash: "" }, history: {}, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop }, localStorage: { getItem: () => null, setItem: noop }, fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout: noop });
  vm.createContext(ctx);
  try { vm.runInContext(DASHBOARD_JS, ctx); } catch { /* ignore boot */ }
  const listeners = { click: (e: unknown) => all.click.forEach((f) => { try { f(e); } catch { /* other click listeners (menu close) need a fuller page */ } }) };
  assert.ok((all.click ?? []).length >= 1, "a click listener is registered");
  vm.runInContext("var CALLS = []; ACTS.armDel = function(el, a){ CALLS.push(['armDel'].concat(a)); }; ACTS.setPin = function(el, a){ CALLS.push(['setPin'].concat(a)); };", ctx);
  const attrs = (m: Record<string, string>) => ({ closest: (sel: string) => { const k = /\[(.+)\]/.exec(sel)![1]; return k in m ? { getAttribute: (n: string) => m[n] ?? null } : null; } });
  listeners.click({ target: attrs({ "data-do": "setPin", "data-args": "[7,true]" }) });
  listeners.click({ target: attrs({ "data-do": "armDel", "data-args": "[4]" }) });
  listeners.click({ target: attrs({ "data-do": "constructor" }) }); // not in the table: ignored
  listeners.click({ target: attrs({ "data-do": "toString" }) });
  listeners.click({ target: attrs({}) });
  assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(CALLS)", ctx) as string), [["setPin", 7, true], ["armDel", 4]]);
});
