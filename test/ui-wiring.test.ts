// Integration of lane/ui with lane/quality, lane/dist and lane/session: the dashboard's switches reach the hooks and the
// backup timer, one backup-status file feeds health, "Needs you" and Settings, the Update button reads the real
// `monomem update` wording, Tidy up replaces whole duplicate groups, and session start says when something needs you.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { promptRecallOn } from "../src/prompt/switches.js";
import { runHook } from "../src/hook.js";
import { runDailyBackup, backupFailure, backupsDir, maybeDailyBackup } from "../src/backup-schedule.js";
import { readBackupStatus, updateUiSettings } from "../src/ui/settings.js";
import { needsYou } from "../src/ui/needs-you.js";
import { runRecall } from "../src/recall.js";
import { runUpdate, type UpdateDeps } from "../src/update.js";
import { DASHBOARD_JS } from "../src/dashboard.js";

const scratch = (p: string): string => mkdtempSync(join(tmpdir(), p));

describe("prompt-time recall: the dashboard switch", () => {
  test("the env var wins when set; otherwise ui-settings.json decides; a missing or broken file is off", () => {
    const dir = scratch("mm-wire-pr-");
    try {
      assert.equal(promptRecallOn({}, dir), false, "no file: off");
      writeFileSync(join(dir, "ui-settings.json"), "{not json");
      assert.equal(promptRecallOn({}, dir), false, "broken file: off");
      updateUiSettings({ prompt_recall: "on" }, dir);
      assert.equal(promptRecallOn({}, dir), true, "switched on in Settings");
      assert.equal(promptRecallOn({ MONOMEM_PROMPT_RECALL: "off" }, dir), false, "env off wins");
      updateUiSettings({ prompt_recall: "off" }, dir);
      assert.equal(promptRecallOn({ MONOMEM_PROMPT_RECALL: "on" }, dir), true, "env on wins");
      assert.equal(promptRecallOn({}, dir), false);
      assert.equal(promptRecallOn({ MONOMEM_PROMPT_RECALL: "" }, dir), false, "an empty env value counts as unset");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the user-prompt hook follows the Settings switch when MONOMEM_PROMPT_RECALL is unset", async () => {
    const home = scratch("mm-wire-hook-");
    const db = join(home, "state.db");
    try {
      const s = new Store(db);
      s.create({ title: "zorblax sharding plan", body: "x" });
      s.close();
      const env = { ...process.env };
      delete env.MONOMEM_PROMPT_RECALL;
      const ask = (sid: string) => runHook("user-prompt", JSON.stringify({ session_id: sid, cwd: home, prompt: "zorblax?" }), { dbPath: db, dataDir: home, env });
      assert.equal(await ask("w1"), "", "off by default");
      updateUiSettings({ prompt_recall: "on" }, home);
      assert.match(await ask("w2"), /zorblax sharding plan/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("daily backups: one status file, the Settings switch, MONOMEM_AUTO_BACKUP", () => {
  function store(): { dir: string; db: string; s: Store; done: () => void } {
    const dir = scratch("mm-wire-bk-");
    const db = join(dir, "state.db");
    const s = new Store(db);
    s.create({ title: "a", body: "b" });
    return { dir, db, s, done: () => { s.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  test("a daily backup writes backup-status.json (ok and failed); health's backupFailure and Needs you read that same file", () => {
    const w = store();
    try {
      mkdirSync(backupsDir(w.db), { recursive: true });
      writeFileSync(join(backupsDir(w.db), "2026-11-16"), "a file where the folder should go");
      runDailyBackup(w.s, w.db, new Date("2026-11-16T09:00:00Z"));
      const st = readBackupStatus(w.dir);
      assert.equal(st?.ok, false);
      assert.ok(st?.error);
      assert.equal(backupFailure(w.db)?.at, st?.at);
      assert.ok(!existsSync(join(w.dir, ".backup-failed")), "no second failure file");
      assert.deepEqual(needsYou(w.s, { dataDir: w.dir, conflicts: false }).items.map((i) => i.kind), ["backup"]);
      const ok = runDailyBackup(w.s, w.db, new Date("2026-11-17T09:00:00Z"));
      assert.equal(ok.made, true);
      assert.equal(readBackupStatus(w.dir)?.ok, true);
      assert.equal(readBackupStatus(w.dir)?.dir, ok.dir);
      assert.equal(backupFailure(w.db), null);
      assert.equal(needsYou(w.s, { dataDir: w.dir, conflicts: false }).count, 0);
    } finally {
      w.done();
    }
  });

  test("maybeDailyBackup: the Settings switch turns it off; MONOMEM_AUTO_BACKUP wins when set", () => {
    const w = store();
    try {
      const now = new Date("2026-11-16T09:00:00Z");
      updateUiSettings({ daily_backups: "off" }, w.dir);
      assert.equal(maybeDailyBackup(w.s, w.db, { env: {}, dataDir: w.dir, now }), null, "switched off in Settings");
      assert.ok(!existsSync(backupsDir(w.db)));
      assert.ok(maybeDailyBackup(w.s, w.db, { env: { MONOMEM_AUTO_BACKUP: "on" }, dataDir: w.dir, now })?.made, "env on wins");
      updateUiSettings({ daily_backups: "on" }, w.dir);
      assert.equal(maybeDailyBackup(w.s, w.db, { env: { MONOMEM_AUTO_BACKUP: "off" }, dataDir: w.dir, now: new Date("2026-11-17T09:00:00Z") }), null, "env off wins");
      assert.ok(maybeDailyBackup(w.s, w.db, { env: {}, dataDir: w.dir, now: new Date("2026-11-17T09:00:00Z") })?.made, "default on");
    } finally {
      w.done();
    }
  });
});

// A stub page, the same shape as the dashboard tests use: no browser, no server.
function page(json: (path: string, o?: { method?: string; body?: string }) => unknown) {
  const els = new Map<string, any>();
  const el = (id: string): any => {
    if (!els.has(id)) {
      const attrs = new Map<string, string>();
      els.set(id, { value: "", style: {}, textContent: "", innerHTML: "", checked: false, className: "", addEventListener() {}, focus() {}, appendChild() {},
        getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v), removeAttribute: (k: string) => void attrs.delete(k) });
    }
    return els.get(id);
  };
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const ctx: any = {
    document: { getElementById: el, createElement: () => ({ style: {} }) },
    sessionStorage: { getItem: () => "tok", setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, encodeURIComponent,
    fetch: async (path: string, o?: { method?: string; body?: string }) => {
      calls.push({ path, method: o?.method ?? "GET", body: o?.body ? JSON.parse(o.body) : undefined });
      return { ok: true, status: 200, json: async () => json(path, o) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(DASHBOARD_JS, ctx);
  return { ctx, el, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Update button: the real `monomem update --check` wording", () => {
  function deps(tag: string, lines: string[]): UpdateDeps {
    return {
      mode: "bundle", root: scratch("mm-wire-upd-"), version: "1.6.0", platform: "linux", arch: "x64", env: {},
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ tag_name: tag, assets: [] }) })) as unknown as typeof fetch,
      out: (l) => { lines.push(l); }, err: (l) => { lines.push(l); }, unpack() {}, run: () => ({ status: 0, stdout: "" }),
    } as UpdateDeps;
  }
  async function shows(tag: string): Promise<boolean> {
    const lines: string[] = [];
    const d = deps(tag, lines);
    try {
      assert.equal(await runUpdate({ check: true }, d), 0);
    } finally {
      rmSync(d.root, { recursive: true, force: true });
    }
    const p = page(() => ({ ok: true, code: 0, output: lines.join("\n") }));
    p.ctx.checkUpdate();
    await settle();
    return /Update now/.test(p.el("upd_out").innerHTML);
  }
  test("a newer release offers Update now; the same version does not (injected fetch, no network)", async () => {
    assert.equal(await shows("v1.7.0"), true);
    assert.equal(await shows("v1.6.0"), false);
  });
});

describe("Tidy up: whole duplicate groups, plain type words, plain writer names", () => {
  const issues = [
    { type: "duplicate", namespace: "w", ids: [3, 9, 5, 7], keep_id: 9, detail: "4 notes say the same thing" },
    { type: "empty", namespace: "w", ids: [11], detail: "#11 has no text" },
    { type: "restated", namespace: "w", ids: [12, 13], detail: "#12 was restated in #13" },
  ];
  test("Replace for a group of 4 keeps keep_id and replaces all three older copies; undo puts each back", async () => {
    const p = page((path) => (path.startsWith("/quality") ? { counts: { duplicate: 1, empty: 1, restated: 1 }, issues } : path === "/supersede/preview" ? { token: "t", warning: "w" } : {}));
    p.ctx.loadQuality();
    await settle();
    const h = p.el("list").innerHTML as string;
    assert.match(h, /Replace #3, #5, #7 with #9/);
    assert.match(h, />no text</);
    assert.match(h, />said again</);
    assert.match(h, /Replace #12 with #13/, "a restated note can be retired from here too");
    assert.match(p.el("count").textContent, /1 no text, 1 said again/);
    p.ctx.qReplace([3, 5, 7], 9);
    await settle();
    assert.deepEqual(p.calls.find((c) => c.path === "/supersede/preview")?.body, { old_ids: [3, 5, 7], new_id: 9, gui: true });
  });
  test("an escaped app-key writer reads as a plain name, never as the terminal it is not", () => {
    const p = page(() => ({}));
    assert.match(p.ctx.chip("token:cli"), />app key &quot;cli&quot;<\/span>$|>app key "cli"<\/span>$/);
    assert.doesNotMatch(p.ctx.chip("token:cli"), />terminal</);
    assert.match(p.ctx.chip("cli"), />terminal<\/span>$/);
  });
});

describe("session start: one line when something needs you", () => {
  test("a failed backup gives one short Needs-you line; nothing waiting gives none", async () => {
    const home = scratch("mm-wire-ss-");
    const db = join(home, "state.db");
    try {
      const s = new Store(db);
      s.create({ title: "plain note", body: "x" });
      s.close();
      const quiet = JSON.parse(await runRecall({ dbPath: db, cwd: home })).hookSpecificOutput.additionalContext as string;
      assert.doesNotMatch(quiet, /need(s)? you/i);
      writeFileSync(join(home, "backup-status.json"), JSON.stringify({ ok: false, at: "2026-11-16T09:00:00Z", error: "disk full" }));
      const ctx = JSON.parse(await runRecall({ dbPath: db, cwd: home })).hookSpecificOutput.additionalContext as string;
      const lines = ctx.split("\n").filter((l) => /waits? for the user/.test(l));
      assert.equal(lines.length, 1, ctx);
      assert.match(lines[0], /1 failed backup/);
      assert.match(lines[0], /monomem open/);
      assert.ok(lines[0].length <= 200);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("local sign-in vs person session (routes-ui.ts header)", () => {
  test("every route under the 'this computer' marker checks the local sign-in before doing anything", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/api/routes-ui.ts", import.meta.url), "utf8");
    const tail = src.slice(src.indexOf("// ---- this computer (local sign-in) ----"));
    const blocks = tail.split(/\n  if \(req\.method === /).slice(1);
    assert.ok(blocks.length >= 7, `found ${blocks.length} routes`);
    for (const b of blocks) assert.match(b.split("\n").slice(0, 2).join("\n"), /if \(needLocal\(\)\) return true;/, b.slice(0, 80));
  });

  test("a local session adds nothing to a lesser key, and a non-terminal sign-in cannot keep a flagged note", async () => {
    const { createApiServer } = await import("../src/api.js");
    const { setUiRunner, setUiStarter } = await import("../src/api/routes-ui.js");
    const { mintLoginCode } = await import("../src/login-code.js");
    const ADMIN = "a".repeat(40), WRITE = "w".repeat(40);
    let ran = 0;
    setUiRunner(async () => (ran++, { code: 0, output: "" }));
    setUiStarter(() => void ran++); // never start a real `monomem update` from a test
    const s = new Store(":memory:");
    const server = createApiServer(s, [{ token: ADMIN, scope: "admin", label: "primary" }, { token: WRITE, scope: "write", label: "cursor" }]);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
      const login = (await (await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: mintLoginCode(Date.now(), false) }) })).json()) as { local_session: string; dashboard_session?: string };
      assert.equal(login.dashboard_session, undefined);
      const h = (key: string) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Monomem-Local": login.local_session });
      for (const [m, p] of [["POST", "/ui/update"], ["POST", "/ui/remove"], ["PUT", "/ui/settings"], ["POST", "/ui/backup"]] as const) {
        assert.equal((await fetch(base + p, { method: m, headers: h(WRITE), body: "{}" })).status, 403, `app key + local session: ${p}`);
      }
      assert.equal((await fetch(base + "/ui/update", { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "X-Monomem-Local": login.local_session } , body: "{}" })).status, 202, "main key + local session: allowed (the update starts detached)");
      assert.equal((await fetch(base + "/ui/update", { method: "POST", headers: { "X-Monomem-Local": login.local_session }, body: "{}" })).status, 401, "a local session is never a key");
      assert.equal((await fetch(base + "/ui/review/1/keep", { method: "POST", headers: h(ADMIN) })).status, 403, "keep needs the terminal (person) session");
      assert.equal(ran, 1);
    } finally {
      setUiRunner(null);
      setUiStarter(null);
      await new Promise<void>((r) => server.close(() => r()));
      s.close();
    }
  });
});
