// Round 4 design fixes (.panel-160/r4-design.md SF-A..SF-D and the LOW list), checked in a stub browser and against the
// /ui/sync route: Repair rows wrap at 360 px, evidence and new-writer labels on note cards, a failed sync shown in Settings
// with what to do, a plain-words "What did this touch?" sheet with a destructive Undo, and the small wording fixes.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CSS } from "../src/ui/css.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "../src/dashboard.js";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { setUiRunner } from "../src/api/routes-ui.js";
import { mintLoginCode } from "../src/login-code.js";
import { DB_PATH } from "../src/config.js";
import { findSources } from "../src/importers/sources.js";

const UA = {
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};

function page(json: (path: string, method: string, body?: unknown) => unknown, ua = UA.win) {
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) {
      const attrs = new Map<string, string>();
      els.set(id, { id, value: "", style: {}, textContent: "", innerHTML: "", hidden: false, open: false, checked: false, className: "", addEventListener() {}, focus() { ctx.document.activeElement = this; }, appendChild() {},
        showModal() { this.open = true; }, close() { this.open = false; }, getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) });
    }
    return els.get(id);
  };
  const calls: string[] = [];
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }), addEventListener() {}, activeElement: null, title: "", querySelectorAll: () => [] },
    sessionStorage: { getItem: (k: string) => (k === "om_tok" ? "tok" : ""), setItem() {}, removeItem() {} },
    navigator: { userAgent: ua }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, encodeURIComponent, Promise,
    fetch: async (path: string, o: any = {}) => (calls.push(`${o.method ?? "GET"} ${path}`), { ok: true, status: 200, json: async () => json(path, o.method ?? "GET", o.body ? JSON.parse(o.body) : undefined) }),
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, el, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const NOTE = { id: 4, title: "Deploy", namespace: "default", written_by: "stdio:claude-code", updated_at: new Date().toISOString(), tags: [], rev: 1 };

describe("SF-A: a Repair row with a long path stays inside a 360 px screen", () => {
  test("the row's text column may shrink and long paths wrap anywhere", () => {
    assert.match(CSS, /\.app>div\{min-width:0\}/);
    assert.match(CSS, /\.app \.help\{overflow-wrap:anywhere\}/);
  });
});

describe("SF-B: evidence and new-writer labels on note cards, in plain words", () => {
  test("new writer and inferred show on the card; observed is in the menu only", () => {
    const p = page(() => ({}));
    const fresh = p.ctx.noteCard({ ...NOTE, new_writer: true, new_writer_label: "[new writer]", basis: "inferred", evidence: [], evidence_label: "[inferred: x]" });
    assert.match(fresh, /class='lbl[^']*'>New writer<span class='sr'>: Monomem saw this app for the first time/);
    assert.match(fresh, /class='lbl[^']*'>Inferred<span class='sr'>: The app cited nothing it saw/);
    assert.doesNotMatch(fresh, /\[new writer\]|\[inferred/);
    const seen = p.ctx.noteCard({ ...NOTE, basis: "observed", evidence: [{ kind: "command", ref: "npm test (exit 0)" }, { kind: "file", ref: "a.ts" }], evidence_label: "[observed: ...]" });
    const chips = seen.slice(0, seen.indexOf("<details")) + seen.slice(seen.indexOf("</details>"));
    assert.doesNotMatch(chips, />Observed</, "observed stays off the card's label row");
    assert.match(seen, /<b>Observed:<\/b> The app says it saw: command npm test \(exit 0\) \(and 1 more\)\. Monomem did not check it\./);
  });
});

describe("SF-C: a failed sync is explained in Settings, with what to do", () => {
  test("loadSync shows the failure, when, the error and a Sync now button", async () => {
    const at = new Date(Date.now() - 5 * 60000).toISOString();
    const p = page((path) => (path === "/ui/sync" ? { set: true, kind: "folder", where: "D:/Sync", auto: true, every_minutes: 30, problem: { kind: "failed", at, error: "the folder D:/Sync is missing" } } : {}));
    p.ctx.loadSync();
    await settle();
    const h = p.el("sync_now").innerHTML as string;
    assert.match(h, /The last sync failed 5 minutes ago: the folder D:\/Sync is missing\./);
    assert.match(h, /data-do='syncNow'>Sync now</);
    assert.doesNotMatch(h, /Syncs by itself/);
  });
  test("Sync now runs `monomem sync` behind the local sign-in only", async () => {
    const runs: string[][] = [];
    setUiRunner(async (args) => (runs.push(args), { code: 0, output: "Synced." }));
    await withServer(async (base) => {
      assert.equal((await call(base, "/ui/sync/now", { method: "POST" })).status, 403);
      const r = await call(base, "/ui/sync/now", { method: "POST", headers: await localHeader(base) });
      assert.equal(r.status, 200);
      assert.deepEqual(runs, [["sync"]]);
    });
  });
  test("GET /ui/sync returns the last failure", async () => {
    await withServer(async (base) => {
      writeFileSync(SYNC_JSON, JSON.stringify({ kind: "folder", target: "D:/Sync", keyFile: "k", auto: true, everyMinutes: 30 }));
      writeFileSync(SYNC_STATUS, JSON.stringify({ at: "2026-11-17T06:27:00.000Z", ok: false, error: "the folder is missing" }));
      const j = (await (await call(base, "/ui/sync", { headers: await localHeader(base) })).json()) as { problem: { kind: string; at: string; error: string } };
      assert.deepEqual(j.problem, { kind: "failed", at: "2026-11-17T06:27:00.000Z", error: "the folder is missing" });
    });
  });
  test("Needs you points to Settings, not a terminal command", async () => {
    const { needsYou } = await import("../src/ui/needs-you.js");
    const dir = mkdtempSync(join(tmpdir(), "om-r4-sync-"));
    const s = new Store(":memory:");
    try {
      writeFileSync(join(dir, "sync.json"), JSON.stringify({ kind: "folder", target: "D:/Sync", keyFile: "k", auto: false, everyMinutes: 30 }));
      writeFileSync(join(dir, "sync-status.json"), JSON.stringify({ at: "2026-11-17T06:27:00.000Z", ok: false }));
      const item = needsYou(s, { dataDir: dir }).items.find((i: { kind: string }) => i.kind === "sync");
      assert.ok(item);
      assert.doesNotMatch(item.text, /monomem sync/);
      assert.match(item.text, /Settings/);
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SF-D: What did this touch? in plain words, Undo styled as destructive", () => {
  const touched = {
    id: 4, namespace: "default", title: "Deploy", created_at: "2026-11-17T06:00:00.000Z",
    reads: [
      { at: new Date(Date.now() - 3 * 60000).toISOString(), reader: "stdio:claude-code", via: "memory_search", proof: "access log" },
      { at: new Date(Date.now() - 2 * 60000).toISOString(), reader: "stdio:claude-code", via: "session start", session_id: "s1", proof: "receipt" },
    ],
    reads_total: 2,
    built_on: [{ id: 7, namespace: "default", title: "Deploy script", task: false, basis: "proven", by: "stdio:cursor", at: new Date().toISOString(), change: "created", why: "saved with derived_from #4" }],
    claimed_tasks: [], replaced: [], hidden: 1, window_hours: 12, retention_days: 30,
    not_recorded: "Not recorded: ... (MONOMEM_ACCESS_LOG_DAYS=0) ... derived_from.",
    text: "What note #4 \"Deploy\" [default] touched:\n  - primary: 16 time(s), 2026-11-17T06:28:22.187Z (GET /notes) derived_from MONOMEM_ACCESS_LOG_DAYS=0",
  };
  const preview = { ok: true, token: "t1", actions: [{ id: 4, namespace: "default", title: "Deploy", rev: 1, action: "archive", basis: "the note" }, { id: 7, namespace: "default", title: "Deploy script", rev: 1, action: "archive", basis: "proven" }], skipped: [], warning: "Archive 2 note(s) ... monomem restore <id> ... confirm with this code: t1" };

  test("the sheet: its own title, plain sentences, Close; the rollback is a secondary button", async () => {
    const p = page((path) => (path === "/notes/4/touched" ? touched : path === "/rollback/preview" ? preview : { ok: true, message: "Undone." }));
    p.ctx.touchedNote(4);
    await settle();
    assert.equal(p.el("cf_h").textContent, "What did this touch?");
    const body = p.el("cf_body").innerHTML as string;
    assert.doesNotMatch(body, /\d{4}-\d\d-\d\dT\d\d:/, "no ISO times");
    assert.doesNotMatch(body, /\[default\]|MONOMEM_|derived_from|<pre/);
    assert.match(body, /Read 2 times/);
    assert.match(body, /Deploy script/);
    assert.match(body, /1 more note you cannot see here/);
    assert.equal(p.el("cf_no").textContent, "Close");
    assert.doesNotMatch(p.el("cf_ok").className, /primary|destructive/);
    assert.notEqual(p.ctx.document.activeElement?.id, "cf_ok", "focus does not land on the undo button");
    p.el("cf_ok").onclick();
    await settle();
    assert.match(p.el("cf_h").textContent, /^Undo note #4 and what was built on it\?$/);
    assert.equal(p.el("cf_ok").className, "destructive fill");
    assert.equal(p.el("cf_no").textContent, "Cancel");
    const plan = p.el("cf_body").innerHTML as string;
    assert.match(plan, /Archive 2 notes/);
    assert.doesNotMatch(plan, /monomem |code: t1/);
    p.el("cf_ok").onclick();
    await settle();
    assert.ok(p.calls.includes("POST /rollback/confirm"));
  });
  test("other confirm sheets keep their title, Cancel and button style", () => {
    const p = page(() => ({}));
    p.ctx.ask("Remove it?", "Remove from my apps", () => {});
    assert.equal(p.el("cf_h").textContent, "Remove from my apps");
    assert.equal(p.el("cf_no").textContent, "Cancel");
    assert.equal(p.el("cf_ok").className, "destructive fill");
    assert.match(DASHBOARD_HTML, /<button id="cf_no" class="plain"/);
  });
});

describe("LOW: small wording and layout fixes", () => {
  test("the banner button opens the place with the most items", () => {
    const p = page(() => ({}));
    p.ctx.VIEW = "list";
    p.ctx.setNeeds({ count: 4, items: [{ view: "held", count: 1, text: "a" }, { view: "settings", count: 1, text: "b" }, { view: "settings", count: 1, text: "c" }, { view: "review", count: 1, text: "d" }] });
    assert.match(p.el("needs").innerHTML, /data-do='openSettings'>Open Settings</);
  });
  test("Welcome Bring in memories: proper plurals and no raw Codex folder", async () => {
    const home = mkdtempSync(join(tmpdir(), "om-r4-src-"));
    try {
      mkdirSync(join(home, ".codex", "memories"), { recursive: true });
      writeFileSync(join(home, ".codex", "memories", "MEMORY.md"), "# notes\nwe deploy with pnpm\n");
      const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex") };
      const found = await findSources({ home, env, cwd: home }, join(home, "state.db"));
      const codex = found.find((s) => s.id === "codex");
      assert.ok(codex, JSON.stringify(found));
      assert.equal(codex.where, "1 memory file");
      assert.ok(found.every((s) => !/\(s\)/.test(s.where)), JSON.stringify(found));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("the New chip says what it means to a screen reader", async () => {
    const p = page((path) => (path === "/ui/apps" ? { apps: [{ id: "cursor", label: "Cursor", new: true }] } : {}));
    p.ctx.loadApps2("set_apps", false);
    await settle();
    assert.match(p.el("set_apps").innerHTML, /<span class='lbl'>New<span class='sr'>: installed after Monomem was set up<\/span><\/span>/);
  });
  for (const [os, words] of [["win", "Windows"], ["mac", "macOS"], ["linux", "Linux"]] as const) {
    test(`the update wait names ${words}, never Windows on another system`, async () => {
      const p = page(() => ({ version: "1.6.0" }), UA[os]);
      p.ctx.setTimeout = (f: () => void) => f();
      p.ctx.waitUpdate(180);
      const h = p.el("upd_out").innerHTML as string;
      assert.match(h, new RegExp(`start with ${words}`));
      if (os !== "win") assert.doesNotMatch(h, /Windows/);
    });
  }
  test("Review wording: no CLI pointer, no (declared)", async () => {
    const p = page((path) => (path === "/ui/review" ? { notes: [{ id: 1, title: "t", namespace: "default", writer: "x", why: "unconfirmed: from outside content (declared), nobody confirmed this version" }], flagged: [], code_changed: [], held_writes: 0, count: 1 } : { conflict_groups: [] }));
    p.ctx.loadReview();
    await settle();
    assert.doesNotMatch(p.el("count").textContent + p.el("viewd").textContent, /monomem review/);
    const list = p.el("list").innerHTML as string;
    assert.doesNotMatch(list, /\(declared\)|this version/);
    assert.match(list, /from outside content \(the app said so\); nobody has confirmed it yet/);
  });
  test("Filters is a 44 px target on phones", () => {
    assert.match(CSS, /\.filters summary\{[^}]*min-width:var\(--tap\)/);
  });
  test("imported notes are called unconfirmed (from outside), not held", () => {
    for (const s of ["comes in unconfirmed (from outside)", "unconfirmed (from outside) until you confirm"]) assert.ok(DASHBOARD_JS.includes(s), s);
    assert.doesNotMatch(DASHBOARD_JS, /comes in held|held until you confirm/);
  });
});

// ---- server helpers (as ui-sync.test.ts) ----
const ADMIN = "a".repeat(40);
const SYNC_JSON = join(dirname(DB_PATH), "sync.json");
const SYNC_STATUS = join(dirname(DB_PATH), "sync-status.json");
afterEach(() => {
  setUiRunner(null);
  rmSync(SYNC_JSON, { force: true });
  rmSync(SYNC_STATUS, { force: true });
});
async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const s = new Store(":memory:");
  const server = createApiServer(s, [{ token: ADMIN, scope: "admin", label: "primary" }]);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    s.close();
  }
}
const call = (base: string, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  fetch(base + path, { method: o.method ?? "GET", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json", ...(o.headers ?? {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) });
async function localHeader(base: string): Promise<Record<string, string>> {
  const r = (await (await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: mintLoginCode(Date.now(), false) }) })).json()) as { local_session: string };
  return { "X-Monomem-Local": r.local_session };
}
