// 1.4.0 fix round 2 (second security review of the fix round): each test names the finding it pins down.
import "./setup-env.js"; // throwaway MONOMEM_HOME before src loads, so a file run alone never touches the real data folder
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store, QuarantinedError } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { actorStore, setProcessWriter } from "../src/actor.js";
import * as tasksMod from "../src/tasks.js";
import { setTtyCheck, sourceKey } from "../src/taint.js";
import { supersedePreview } from "../src/supersede.js";
import { parseArgs, supersedeCli, historyCli } from "../src/supersede-cli.js";
import { mintLoginCode } from "../src/login-code.js";
import { resolveToken } from "../src/config.js";
import { spoolEvent, drainSpool, normalizeHookInput } from "../src/capture.js";

const as = <T>(label: string, f: () => T, extra: Record<string, unknown> = {}): T => actorStore.run({ label, authed: true, ...extra }, f);
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
afterEach(() => {
  setProcessWriter("");
  setTtyCheck(undefined);
});

describe("N1: a repeated flag cannot point the gate at one note and the action at another", () => {
  test("parseArgs refuses a repeated value flag, both forms", () => {
    assert.throws(() => parseArgs(["--new-id", "5", "--new-id", "99"]), /--new-id was given more than once/);
    assert.throws(() => parseArgs(["--confirm-token=a", "--confirm-token=b"]), /--confirm-token was given more than once/);
    assert.throws(() => parseArgs(["--old=1", "--old", "2"]), /--old was given more than once/);
  });

  test("the gate runs inside supersedeCli / historyCli on the ids the command acts on", async () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    const old = s.create({ title: "Acme price is $50" });
    const tainted = as("research-bot", () => s.create({ title: "Acme price is $5", outside: true }));
    const p = supersedePreview(s, { scope: "admin" }, { old_ids: [old.id], new_id: tainted.id });
    const gated: Array<[string, number[]]> = [];
    let throwOn = "outside";
    const io = {
      out: () => undefined,
      err: () => undefined,
      ask: async () => "",
      interactive: false,
      gate: async (kind: "pinned" | "outside", ids: number[]) => {
        gated.push([kind, ids]);
        if (kind === throwOn) throw new Error("refused by the gate");
      },
    };
    await assert.rejects(() => supersedeCli(s, ["--confirm-token", p.token], io as any), /refused by the gate/);
    assert.ok(gated.some(([k, ids]) => k === "outside" && ids.includes(tainted.id)), JSON.stringify(gated));
    assert.equal(s.read(tainted.id)!.confirmed_kind, undefined);
    s.setPinned(old.id, true);
    gated.length = 0;
    throwOn = "pinned";
    s.update(old.id, { body: "v2" });
    await assert.rejects(() => historyCli(s, ["restore", "--if-rev", "999", String(old.id), "1"], io as any), /refused by the gate/);
    assert.deepEqual(gated, [["pinned", [old.id]]]);
    s.close();
  });

  test("CLI from a script: duplicated --confirm-token is refused, nothing confirmed or replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-dupflag-"));
    try {
      const db = join(dir, "state.db");
      const s = new Store(db);
      setProcessWriter("cli");
      const a = s.create({ title: "Acme price is $50" });
      const clean = s.create({ title: "Acme price is $45" });
      const b = s.create({ title: "Beta price is $9" });
      const tainted = as("research-bot", () => s.create({ title: "Beta price is $1", outside: true }));
      const t1 = supersedePreview(s, { scope: "admin" }, { old_ids: [a.id], new_id: clean.id }).token;
      const t2 = supersedePreview(s, { scope: "admin" }, { old_ids: [b.id], new_id: tainted.id }).token;
      s.close();
      const env = { ...process.env, MONOMEM_HOME: dir, MONOMEM_DB_PATH: db };
      const cli = (...args: string[]) => spawnSync(process.execPath, [join(process.cwd(), "dist/src/cli.js"), "supersede", ...args], { env, encoding: "utf8" });
      for (const r of [cli("--confirm-token", t1, "--confirm-token", t2), cli(`--confirm-token=${t1}`, `--confirm-token=${t2}`)]) {
        assert.notEqual(r.status, 0, r.stdout + r.stderr);
      }
      const t = new Store(db);
      assert.equal(t.read(tainted.id)!.confirmed_kind, undefined, "no fake human confirm");
      assert.equal(t.read(b.id)!.status, undefined);
      assert.equal(t.read(a.id)!.status, undefined);
      t.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function api(store: Store, tokens: Array<{ token: string; scope: "admin" | "write"; label: string }>) {
  const http = createApiServer(store, tokens);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const close = () =>
    new Promise<void>((r) => {
      http.closeAllConnections();
      http.close(() => r());
    });
  return { base, close };
}

describe("N2: only a dashboard session signed in with monomem open skips read_it", () => {
  test("an admin token that read the note: not counted; the dashboard session: counted as admin", async () => {
    const store = new Store(":memory:");
    const a = as("research-bot", () => store.create({ title: "Acme pricing", outside: true }));
    const b = as("research-bot", () => store.create({ title: "Beta pricing", outside: true }));
    const tok = resolveToken(); // the key monomem open signs the dashboard in as
    setTtyCheck(() => true); // monomem open run at a terminal
    const { base, close } = await api(store, [{ token: tok, scope: "admin", label: "boss" }]);
    try {
      const h = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
      await fetch(`${base}/notes`, { headers: h });
      const agent = (await (await fetch(`${base}/notes/${a.id}/confirm`, { method: "POST", headers: h, body: JSON.stringify({ source: "x" }) })).json()) as any;
      assert.equal(agent.counted, false, JSON.stringify(agent));
      assert.equal(agent.reason, "read_it");
      const login = (await (await fetch(`${base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: mintLoginCode() }) })).json()) as any;
      assert.ok(login.dashboard_session, JSON.stringify(Object.keys(login)));
      const dh = { ...h, "x-monomem-dashboard": login.dashboard_session };
      await fetch(`${base}/notes`, { headers: dh });
      const human = (await (await fetch(`${base}/notes/${b.id}/confirm`, { method: "POST", headers: dh, body: JSON.stringify({ source: "checked in the dashboard" }) })).json()) as any;
      assert.equal(human.counted, true, JSON.stringify(human));
      assert.equal(human.kind, "admin");
    } finally {
      await close();
      store.close();
    }
  });
});

describe("N3: a weaker confirm never moves a stronger confirm's clock", () => {
  test("corroboration after a person's confirm leaves confirmed_at and kind alone, and says the stored due date", () => {
    const s = new Store(":memory:");
    const n = as("research-bot", () => s.create({ title: "Acme pricing", outside: true }));
    setProcessWriter("cli");
    s.confirm(n.id, { source: "called them" });
    setProcessWriter("");
    s.captureDb().prepare("UPDATE notes SET confirmed_at = ?, updated_at = ?, grandfathered_at = NULL WHERE id = ?").run(ago(31), ago(31), n.id);
    s.captureDb().prepare("UPDATE confirmations SET at = ?").run(ago(31));
    const before = s.read(n.id)!.confirmed_at;
    const r = as("checker", () => s.confirm(n.id, { source: "https://acme.example" }))!;
    const after = s.read(n.id)!;
    assert.equal(after.confirmed_at, before, "clock not moved");
    assert.equal(after.confirmed_kind, "human");
    assert.equal(after.expired, true, "still expired: a person or admin must re-confirm");
    assert.ok(!/Next check due/.test(r.message) || r.message.includes(new Date(Date.parse(before!) + 30 * DAY).toISOString().slice(0, 10)), r.message);
    s.close();
  });
});

describe("N4: a cli write from a script is retro-marked by a spooled outside read", () => {
  test("non-terminal cli write marked; terminal cli write not", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-n4-"));
    try {
      const s = new Store(":memory:");
      spoolEvent(dir, { ...normalizeHookInput("post-tool", { session_id: "late", cwd: "C:/w", tool_name: "WebFetch", tool_input: { url: "https://x" }, tool_response: "p" }, new Date(Date.now() - 60_000)), namespace: "default" });
      setProcessWriter("cli");
      setTtyCheck(() => false);
      const piped = s.create({ title: "from a script" });
      setTtyCheck(() => true);
      const typed = s.create({ title: "typed" });
      setProcessWriter("");
      drainSpool(s, dir);
      assert.equal(s.read(piped.id)!.unconfirmed, true);
      assert.equal(s.read(typed.id)!.unconfirmed, undefined);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("L-a: held items cannot crowd the board", () => {
  test("a clean handoff behind six held ones, and a clean task behind 201 held ones, still show", () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    tasksMod.writeHandoff(s, { surface: "pc", summary: "CLEAN-HANDOFF" });
    tasksMod.putTask(s, { title: "CLEAN-TASK", next_step: "x" });
    actorStore.run({ label: "", taint: ["obs.origin:declared"] }, () => {
      for (let i = 0; i < 6; i++) tasksMod.writeHandoff(s, { surface: "pc", summary: `held ${i}` });
      for (let i = 0; i < 201; i++) tasksMod.putTask(s, { title: `held task ${i}`, next_step: "x" });
    });
    const board = tasksMod.sessionBoard(s, {});
    assert.match(board, /CLEAN-HANDOFF/);
    assert.match(board, /CLEAN-TASK/);
    assert.ok(!board.includes("held task"));
    s.close();
  });
});

describe("L-b: enforce-mode expiry does not apply to tasks and handoffs", () => {
  test("an old task is not expired and stays on the board", () => {
    const s = new Store(":memory:");
    s.setConfirmSettings({ mode: "enforce" });
    setProcessWriter("cli");
    const t = tasksMod.putTask(s, { title: "OLD-TASK", next_step: "x" });
    s.captureDb().prepare("UPDATE notes SET updated_at = ?, grandfathered_at = NULL").run(ago(400));
    s.captureDb().prepare("UPDATE _meta SET value = ? WHERE key = 'confirm_mode_set_at'").run(ago(400));
    (s as any).confirmCache = null;
    assert.equal(s.read(t.task.id)!.expired, undefined);
    assert.equal(s.expiredCount(), 0);
    assert.match(tasksMod.sessionBoard(s, {}), /OLD-TASK/);
    s.close();
  });
});

describe("L-c: sourceKey reads schemeless hosts with a path or port", () => {
  test("vendor.com/page and host:8080", () => {
    assert.equal(sourceKey("vendor.com/page"), "vendor.com");
    assert.equal(sourceKey("www.Vendor.com/pricing?x=1"), "vendor.com");
    assert.equal(sourceKey("host:8080"), "host");
    assert.equal(sourceKey("vendor.com:8443/x"), "vendor.com");
    assert.equal(sourceKey("called the vendor"), "called the vendor");
  });
});

describe("L-d: the approval view says a held edit clears confidence or the forget date", () => {
  test("quarantineContext lists the clears", () => {
    const s = new Store(":memory:");
    setProcessWriter("cli");
    const n = s.create({ namespace: "p", title: "Acme price", body: "40", confidence: 0.8 });
    s.setApproveFirst("p", true);
    setProcessWriter("stdio");
    let qid = 0;
    try {
      s.update(n.id, { body: "41", confidence: null });
    } catch (e) {
      if (e instanceof QuarantinedError) qid = e.quarantineId;
      else throw e;
    }
    assert.deepEqual((s.quarantineContext(qid) as any).clears, ["confidence"]);
    s.close();
  });
});
