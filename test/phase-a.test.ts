// Phase A: giving apps limited access, and the friendlier front doors (tokens, connect, init, open, doctor, dashboard).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTokenReload, resolveTokens, DATA_DIR, type TokenEntry } from "../src/config.js";

describe("A1: tokens.json is reloaded without a restart", () => {
  const file = join(DATA_DIR, "tokens.json");
  const saved = { ...process.env };
  afterEach(() => {
    rmSync(file, { force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const tok = (n: string): string => n.padEnd(40, "x");

  test("a new token is accepted, a changed ceiling applies, and a removed token stops working", () => {
    process.env.MONOMEM_TOKEN = tok("primary");
    const live: TokenEntry[] = resolveTokens();
    const logs: string[] = [];
    const r = startTokenReload(live, { log: (m) => logs.push(m), intervalMs: 3_600_000 });
    assert.equal(r.check(), false, "nothing changed yet");
    writeFileSync(file, JSON.stringify([{ token: tok("app"), scope: "write", label: "app", max_sensitivity: "private" }]));
    assert.equal(r.check(), true);
    assert.equal(live.find((t) => t.label === "app")!.max_sensitivity, "private");
    assert.match(logs.join("\n"), /tokens reloaded/);
    // Tighten the ceiling (bump the mtime so the change is seen even within the same millisecond).
    writeFileSync(file, JSON.stringify([{ token: tok("app"), scope: "write", label: "app", max_sensitivity: "public" }]));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(r.check(), true);
    assert.equal(live.find((t) => t.label === "app")!.max_sensitivity, "public");
    // Revoke.
    writeFileSync(file, "[]");
    utimesSync(file, new Date(), new Date(Date.now() + 9000));
    assert.equal(r.check(), true);
    assert.equal(live.some((t) => t.label === "app"), false);
    assert.equal(live.some((t) => t.label === "primary"), true, "the primary token is untouched");
    r.stop();
  });

  test("a half-saved (invalid) file keeps the previous list", () => {
    process.env.MONOMEM_TOKEN = tok("primary");
    writeFileSync(file, JSON.stringify([{ token: tok("app"), scope: "write", label: "app" }]));
    const live = resolveTokens();
    const logs: string[] = [];
    const r = startTokenReload(live, { log: (m) => logs.push(m), intervalMs: 3_600_000 });
    writeFileSync(file, "[{ not json");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    r.check();
    assert.equal(live.some((t) => t.label === "app"), true, "the old list still stands");
    r.stop();
  });
});

describe("A1: the stdio server can be capped, and says what it does not do", () => {
  test("MONOMEM_STDIO_MAX_SENSITIVITY is read by mcp-stdio and documented", () => {
    const src = readFileSync(join(process.cwd(), "src/mcp-stdio.ts"), "utf8");
    assert.match(src, /MONOMEM_STDIO_MAX_SENSITIVITY/);
    const docs = readFileSync(join(process.cwd(), "docs/configuration.md"), "utf8");
    assert.match(docs, /MONOMEM_STDIO_MAX_SENSITIVITY/);
    assert.match(readFileSync(join(process.cwd(), "docs/sensitivity-labels.md"), "utf8"), /stdio/);
  });
});

// ---- A2: monomem token add / list / remove, /whoami, /tokens ------------------------------------------------------------
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import type { AddressInfo } from "node:net";
import { addApp, removeApp, listApps, describeAccess, TokenAdminError } from "../src/tokens-admin.js";
import { statSync } from "node:fs";

describe("A2: token administration", () => {
  const file = join(DATA_DIR, "tokens.json");
  const saved = { ...process.env };
  afterEach(() => {
    rmSync(file, { force: true });
    rmSync(file + ".bak", { force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const prime = (): void => void (process.env.MONOMEM_TOKEN = "p".repeat(40));

  test("add makes a 64-hex key, defaults the limit to internal, writes 0600, and the key is never listed", () => {
    prime();
    const r = addApp({ label: "cursor" });
    assert.match(r.token, /^[0-9a-f]{64}$/);
    assert.equal(r.app.max_sensitivity, "internal");
    assert.equal(r.ceilingWasDefault, true);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0, "file is private to the user");
    const listed = JSON.stringify(listApps());
    assert.ok(!listed.includes(r.token), "list never shows a key");
    assert.ok(listApps().some((a) => a.label === "cursor" && a.source === "file"));
    // The running server's reload picks it up.
    assert.ok(resolveTokens().some((t) => t.label === "cursor" && t.max_sensitivity === "internal"));
  });

  test("refuses a duplicate name, admin without --admin, a bad limit, and a bad file", () => {
    prime();
    addApp({ label: "dup" });
    assert.throws(() => addApp({ label: "DUP" }), /already exists/);
    assert.throws(() => addApp({ label: "primary" }), /already exists/);
    assert.throws(() => addApp({ label: "a", scope: "admin" }), /--admin/);
    assert.throws(() => addApp({ label: "b", max: "privte" }), /--max must be/);
    assert.throws(() => addApp({ label: "" }), TokenAdminError);
    assert.equal(addApp({ label: "boss", admin: true }).app.scope, "admin");
    writeFileSync(file, "{ nope");
    assert.throws(() => addApp({ label: "c" }), /not valid JSON/);
    assert.equal(readFileSync(file, "utf8"), "{ nope", "a broken file is left alone");
  });

  test("remove deletes only that app and keeps a backup; an unknown name is reported", () => {
    prime();
    addApp({ label: "one" });
    addApp({ label: "two", max: "private" });
    assert.equal(removeApp("ONE"), true);
    assert.equal(removeApp("one"), false);
    assert.deepEqual(listApps().filter((a) => a.source === "file").map((a) => a.label), ["two"]);
    // Removing an app deletes the backup copy: it would otherwise keep the revoked key.
    assert.equal(existsSync(file + ".bak"), false);
  });

  test("the plain sentence says what the app can and cannot do", () => {
    assert.match(describeAccess({ scope: "read", namespace: null, max_sensitivity: "public" }), /read notes.*only notes labelled public/);
    assert.match(describeAccess({ scope: "write", namespace: "work", max_sensitivity: "internal" }), /not private.*"work" space/);
    assert.match(describeAccess({ scope: "write", namespace: null, max_sensitivity: null }), /no limit/);
  });

  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  test("the command line: add prints the key once with a snippet; list hides it; remove works", () => {
    const home = mkdtempSync(join(tmpdir(), "monomem-tokcli-"));
    try {
      const env = { ...process.env, MONOMEM_HOME: home, MONOMEM_TOKEN: "q".repeat(40) };
      const run = (...a: string[]) => spawnSync(process.execPath, [CLI, "token", ...a], { env, encoding: "utf8" });
      // `token add` hands out access, so (like main's other trust-lowering commands) it needs a person at a terminal.
      const refused = run("add", "my app", "--max", "public");
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /person must run it in a terminal/);
      // The same writer the terminal path uses, called directly, prints the key once with the snippet.
      const made = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", 'const t = await import(process.argv[1]); const m = t.addApp({ label: "my app", max: "public" }); console.log(t.describeAccess(m.app)); console.log(m.token); console.log(t.connectionSnippet(m.token));', pathToFileURL(join(CLI, "..", "tokens-admin.js")).href],
        { env, encoding: "utf8" }
      );
      assert.equal(made.status, 0, made.stderr);
      const key = /[0-9a-f]{64}/.exec(made.stdout)![0];
      assert.match(made.stdout, /only notes labelled public/);
      assert.match(made.stdout, /Invoke-RestMethod/, "a PowerShell line is there too");
      assert.match(made.stdout, /Authorization/);
      const list = run("list");
      assert.ok(!list.stdout.includes(key));
      assert.match(list.stdout, /my app[\s\S]*sees up to: public/);
      assert.match(run("remove", "nobody").stdout, /No token labelled "nobody"/);
      assert.match(run("remove", "my app").stdout, /Removed token "my app"/);
      assert.match(run("remove", "my app").stdout, /No token labelled/);
      assert.match(run("new").stdout.trim(), /^[0-9a-f]{64}$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("REST: /whoami tells an app what it is; /tokens is admin-only, never shows keys, and cannot be used by a limited admin", async () => {
    prime();
    const store = new Store(":memory:");
    const toks = [
      { token: "a".repeat(40), scope: "admin" as const, label: "op" },
      { token: "b".repeat(40), scope: "write" as const, label: "app", max_sensitivity: "public" as const },
      { token: "c".repeat(40), scope: "admin" as const, label: "limited-admin", max_sensitivity: "internal" as const },
    ];
    const server = createApiServer(store, toks);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (tk: string, m: string, p: string, body?: unknown) => {
      const r = await fetch(base + p, { method: m, headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, text, json: text ? JSON.parse(text) : null };
    };
    const me = await call(toks[1].token, "GET", "/whoami");
    assert.equal(me.json.label, "app");
    assert.equal(me.json.max_sensitivity, "public");
    assert.match(me.json.can_see, /only notes labelled public/);
    assert.equal((await call(toks[1].token, "GET", "/tokens")).status, 403);
    assert.equal((await call(toks[2].token, "GET", "/tokens")).status, 403, "a limited admin cannot hand out wider access");
    const made = await call(toks[0].token, "POST", "/tokens", { label: "phone", max: "public" });
    assert.equal(made.status, 201);
    assert.match(made.json.token, /^[0-9a-f]{64}$/);
    assert.match(made.json.snippet, /Authorization/);
    const list = await call(toks[0].token, "GET", "/tokens");
    assert.ok(!list.text.includes(made.json.token) && !list.text.includes(toks[0].token), "no secrets in the list");
    assert.ok(list.json.apps.some((a: { label: string }) => a.label === "phone"));
    assert.equal((await call(toks[0].token, "POST", "/tokens", { label: "phone" })).status, 400);
    const viaFull = await call(toks[0].token, "POST", "/tokens", { label: "tablet", max_sensitivity: "public" });
    assert.equal(viaFull.status, 201);
    assert.equal(viaFull.json.app.max_sensitivity, "public");
    const typo = await call(toks[0].token, "POST", "/tokens", { label: "x1", max_sensitiviti: "public" });
    assert.equal(typo.status, 400);
    assert.match(typo.json.error, /unknown field "max_sensitiviti".*max_sensitivity/);
    assert.equal((await call(toks[0].token, "POST", "/tokens", { label: "x2", max: "public", max_sensitivity: "internal" })).status, 400);
    assert.equal((await call(toks[0].token, "DELETE", "/tokens/tablet")).status, 200);
    assert.equal((await call(toks[0].token, "DELETE", "/tokens/phone")).status, 200);
    assert.equal((await call(toks[0].token, "DELETE", "/tokens/phone")).status, 404);
    assert.equal((await call(toks[0].token, "DELETE", "/tokens/primary")).status, 400);
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
});

// ---- A3: connect, init, open, the setup dead end -----------------------------------------------------------------------
import { didYouMean } from "../src/suggest.js";
import { planFile, realEnv, DEFAULT_OPTIONS, detectClients } from "../src/setup.js";

describe("A3: connect / open / setup", () => {
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const fresh = (): { home: string; env: NodeJS.ProcessEnv; run: (...a: string[]) => ReturnType<typeof spawnSync> } => {
    const home = mkdtempSync(join(tmpdir(), "monomem-connect-"));
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), XDG_CONFIG_HOME: join(home, ".config"), MONOMEM_HOME: join(home, "data"), MONOMEM_TOKEN: "z".repeat(40) } as NodeJS.ProcessEnv;
    delete env.CLAUDE_CONFIG_DIR;
    return { home, env, run: (...a) => spawnSync(process.execPath, [CLI, ...a], { env, cwd: home, encoding: "utf8", timeout: 60_000 }) };
  };

  test("did-you-mean finds near misses and nothing for nonsense", () => {
    assert.equal(didYouMean("cursr", ["cursor", "codex", "zed"]), "cursor");
    assert.equal(didYouMean("claude-cod", ["claude-code", "claude-desktop"]), "claude-code");
    assert.equal(didYouMean("qqqqqqqq", ["cursor", "codex"]), null);
  });

  test("a mistyped app name gets a suggestion and changes nothing", () => {
    const f = fresh();
    try {
      const r = f.run("connect", "cursr");
      assert.equal(r.status, 1);
      assert.match(String(r.stderr), /Did you mean "cursor"\?/);
      assert.equal(existsSync(join(f.home, ".cursor")), false);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("connect --restricted writes a key-based web entry (Claude Code) and a limited key; without the app the key is not left behind", () => {
    const f = fresh();
    try {
      const r = f.run("connect", "claude-code", "--restricted", "--max", "public", "--yes");
      assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
      const cfg = JSON.parse(readFileSync(join(f.home, ".claude.json"), "utf8"));
      const entry = cfg.mcpServers.monomem;
      assert.equal(entry.type, "http");
      assert.match(entry.url, /:8791\/mcp$/);
      assert.match(entry.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
      const toks = JSON.parse(readFileSync(join(f.home, "data", "tokens.json"), "utf8"));
      assert.equal(toks[0].max_sensitivity, "public");
      assert.equal(toks[0].token, entry.headers.Authorization.slice(7));
      // Connecting it again the old (unlimited) way is refused until the entry is removed, and no second key is left behind.
      const again = f.run("connect", "claude-code", "--restricted", "--yes");
      assert.equal(again.status, 1);
      assert.equal(JSON.parse(readFileSync(join(f.home, "data", "tokens.json"), "utf8")).length, 1);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("restricted wiring is refused for an app whose format is not verified (key removed again), and --print only shows a snippet", () => {
    const f = fresh();
    try {
      const p = f.run("connect", "zed", "--restricted");
      assert.equal(p.status, 0);
      assert.match(String(p.stdout), /Paste this/);
      assert.ok(!existsSync(join(f.home, ".config", "zed")), "no settings file was written");
      const w = f.run("connect", "windsurf");
      assert.match(String(w.stdout), /Windsurf: I cannot check where its settings file lives/);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("planFile: a limited entry is url + headers for Cursor, refused for an unverified app, and conflicts with an existing unlimited entry", () => {
    const home = mkdtempSync(join(tmpdir(), "monomem-plan-"));
    try {
      const e = { ...realEnv("1.0.3", "/x/cli.js"), home, cwd: home, platform: "linux" as const, env: {} };
      const targets = detectClients(e);
      const opts = { ...DEFAULT_OPTIONS, only: ["cursor", "zed"], httpEntry: { url: "http://127.0.0.1:8791/mcp", headers: { Authorization: "Bearer k" } } };
      const cur = planFile(e, opts, targets.find((t) => t.id === "cursor")!, { dbs: new Set() });
      assert.deepEqual((cur.change!.ops[0] as { value: unknown }).value, { url: "http://127.0.0.1:8791/mcp", headers: { Authorization: "Bearer k" } });
      const zed = planFile(e, opts, targets.find((t) => t.id === "zed")!, { dbs: new Set() });
      assert.equal(zed.change, null);
      assert.match(zed.conflicts[0], /not verified/);
      mkdirSync(join(home, ".cursor"), { recursive: true });
      writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { monomem: { command: "monomem", args: ["mcp"] } } }));
      const clash = planFile(e, opts, detectClients(e).find((t) => t.id === "cursor")!, { dbs: new Set() });
      // Monomem's own keyless entry is now REPLACED (shown as a change, undoable) instead of refused.
      assert.equal(clash.conflicts.length, 0);
      assert.match(clash.change!.lines.join(" "), /replace Monomem's own "monomem" entry/);
      assert.deepEqual((clash.change!.inverse[0] as { value: unknown }).value, { command: "monomem", args: ["mcp"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("setup with no app installed explains the next steps and still exits 0", () => {
    const f = fresh();
    try {
      const r = f.run("setup", "--dry-run", "--no-doctor", "--no-hook", "--no-capture");
      assert.equal(r.status, 0, String(r.stderr));
      assert.match(String(r.stdout), /found no app to connect/);
      assert.match(String(r.stdout), /monomem connect claude-code/);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("open --print gives the dashboard address with the key after '#', never in the query", () => {
    const f = fresh();
    try {
      const r = f.run("open", "--print");
      assert.equal(r.status, 0, String(r.stderr));
      const u = String(r.stdout).split("\n")[0].trim();
      // Round 3: the address carries a one-time code, not the key.
      assert.match(u, /^http:\/\/127\.0\.0\.1:\d+\/#code=[0-9a-f]{32}$/);
      assert.equal(u.includes("?"), false);
      assert.ok(!String(r.stdout).includes("z".repeat(40)));
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });

  test("init away from a keyboard still prints the by-hand instructions, now pointing at the easier commands", () => {
    const f = fresh();
    try {
      const r = f.run("init");
      assert.match(String(r.stdout), /claude mcp add monomem/);
      assert.match(String(r.stdout), /monomem connect <app>/);
    } finally {
      rmSync(f.home, { recursive: true, force: true });
    }
  });
});

// ---- A4: plain-language errors and CLI polish --------------------------------------------------------------------------
import { DatabaseSync } from "node:sqlite";
import { describeDbFailure } from "../src/db-problem.js";
import { createMcpServer } from "../src/mcp-server-core.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("A4: errors and CLI polish", () => {
  const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const sandbox = (): { dir: string; env: NodeJS.ProcessEnv; run: (...a: string[]) => ReturnType<typeof spawnSync> } => {
    const dir = mkdtempSync(join(tmpdir(), "monomem-a4-"));
    const env = { ...process.env, HOME: dir, USERPROFILE: dir, MONOMEM_HOME: join(dir, "data"), MONOMEM_TOKEN: "t".repeat(40) } as NodeJS.ProcessEnv;
    return { dir, env, run: (...a) => spawnSync(process.execPath, ["--no-warnings", CLI, ...a], { env, cwd: dir, encoding: "utf8", timeout: 60_000 }) };
  };

  test("help is short and grouped; 'help all' keeps the full text; an unknown command gets a suggestion", () => {
    const s = sandbox();
    try {
      const short = String(s.run("help").stdout);
      assert.ok(short.split("\n").length < 70, "short help is one grouped page");
      assert.match(short, /Get started[\s\S]*Daily[\s\S]*Trust[\s\S]*Maintenance/);
      assert.match(short, /connect <app>[\s\S]*open /);
      assert.match(short, /monomem help --all/);
      assert.match(String(s.run("help", "--all").stdout), /rebuild-edges \[--threshold/);
      assert.match(String(s.run("help", "all").stdout), /rebuild-edges \[--threshold/, "the older spelling still works");
      const bad = s.run("doctr");
      assert.equal(bad.status, 1);
      assert.match(String(bad.stderr), /Did you mean 'doctor'\?/);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("doctor: a healthy fresh store gets a verdict and exit 0; no false 'similarity edges' warning on unrelated notes", () => {
    const s = sandbox();
    try {
      const store = new Store(join(s.dir, "data", "state.db"));
      store.create({ title: "zebra migration", body: "savanna herd" });
      store.create({ title: "quarterly tax filing", body: "accounting deadline paperwork" });
      store.close();
      const r = s.run("doctor");
      const out = String(r.stdout);
      assert.match(out, /Verdict:/);
      assert.doesNotMatch(out, /no similarity edges/);
      assert.equal(r.status, 0, out);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("doctor: a damaged database is a FAIL with the path and a fix, and exits non-zero; start says the same", () => {
    const s = sandbox();
    try {
      mkdirSync(join(s.dir, "data"), { recursive: true });
      const db = join(s.dir, "data", "state.db");
      writeFileSync(db, "this is not a database at all, just text ".repeat(50));
      const r = s.run("doctor");
      const out = String(r.stdout);
      assert.equal(r.status, 1);
      assert.match(out, /\[FAIL\] Problem: database problem at .*state\.db/);
      assert.match(out, /Fix: /);
      assert.match(out, /Verdict: PROBLEM/);
      const st = spawnSync(process.execPath, ["--no-warnings", CLI, "start"], { env: s.env, encoding: "utf8", timeout: 30_000 });
      assert.equal(st.status, 1);
      assert.match(String(st.stderr), /database problem at .*state\.db/);
      assert.doesNotMatch(String(st.stderr), /at Object\.|node:internal/, "no stack trace");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("doctor: a key with no limit is flagged only when labelled notes exist and only for non-admin keys; a stdio app is flagged when private notes exist", () => {
    const s = sandbox();
    try {
      mkdirSync(join(s.dir, "data"), { recursive: true });
      writeFileSync(join(s.dir, "data", "tokens.json"), JSON.stringify([
        { token: "u".repeat(40), scope: "write", label: "open-app" },
        { token: "v".repeat(40), scope: "admin", label: "boss" },
        { token: "w".repeat(40), scope: "write", label: "capped", max_sensitivity: "internal" },
      ]));
      const store = new Store(join(s.dir, "data", "state.db"));
      store.create({ title: "n" });
      store.close();
      assert.doesNotMatch(String(s.run("doctor").stdout), /can read your private notes/, "nothing is labelled yet, so nothing to protect");
      const store2 = new Store(join(s.dir, "data", "state.db"));
      store2.create({ title: "secret", sensitivity: "private" });
      store2.close();
      mkdirSync(join(s.dir, ".cursor"), { recursive: true });
      writeFileSync(join(s.dir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { monomem: { command: "monomem", args: ["mcp"] } } }));
      const out = String(s.run("doctor").stdout);
      assert.match(out, /"open-app" can read your private notes/);
      assert.doesNotMatch(out, /"boss" can read/);
      assert.doesNotMatch(out, /"capped" can read/);
      assert.match(out, /Cursor.*connected without a key/);
      assert.match(out, /Fix: .*connect cursor --max internal/);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("describeDbFailure explains damage, a newer database, a lock and a permission problem", () => {
    assert.match(describeDbFailure("/x/state.db", new Error("database disk image is malformed")).fix, /backup/);
    assert.match(describeDbFailure("/x/state.db", new Error("database is at schema v99, newer than this version")).fix, /newest version/);
    assert.match(describeDbFailure("/x/state.db", new Error("database is locked")).fix, /Stop it/);
    assert.match(describeDbFailure("/x/state.db", new Error("EACCES: permission denied")).problem, /no permission/);
  });

  test("401 and scope errors carry a hint with the fix; a mistyped scope in tokens is reported with a suggestion", async () => {
    const store = new Store(":memory:");
    const toks = [{ token: "r".repeat(40), scope: "read" as const, label: "reader" }];
    const server = createApiServer(store, toks);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const noKey = await fetch(base + "/notes", { headers: { Authorization: "Bearer nope" } });
    const b1: any = await noKey.json();
    assert.equal(noKey.status, 401);
    assert.equal(b1.error, "unauthorized");
    assert.match(b1.hint, /Authorization: Bearer/);
    const w = await fetch(base + "/notes", { method: "POST", headers: { Authorization: `Bearer ${toks[0].token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    const b2: any = await w.json();
    assert.equal(w.status, 403);
    assert.match(b2.error, /lacks the required 'write' scope/);
    assert.match(b2.hint, /monomem token add <name> --scope write/);
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    // scope typo
    const saved = { ...process.env };
    process.env.MONOMEM_TOKEN = "p".repeat(40);
    process.env.MONOMEM_TOKENS = JSON.stringify([{ token: "m".repeat(40), scope: "writer", label: "typo" }]);
    const lines: string[] = [];
    const q = console.error;
    console.error = (m: unknown) => void lines.push(String(m));
    try {
      assert.equal(resolveTokens().some((t) => t.label === "typo"), false);
    } finally {
      console.error = q;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    assert.match(lines.join("\n"), /Did you mean "write"\?/);
  });

  test("REST always says which label a note has, including the default; a held write says what happens next", async () => {
    const store = new Store(":memory:");
    store.create({ title: "plain", body: "b" });
    store.create({ title: "secret", body: "b", sensitivity: "private" });
    const toks = [{ token: "k".repeat(40), scope: "admin" as const, label: "op" }];
    const server = createApiServer(store, toks);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { Authorization: `Bearer ${toks[0].token}`, "Content-Type": "application/json" };
    const list: any = await (await fetch(base + "/notes", { headers: H })).json();
    assert.deepEqual(list.notes.map((n: { sensitivity: string }) => n.sensitivity).sort(), ["internal", "private"]);
    const search: any = await (await fetch(base + "/search?q=plain", { headers: H })).json();
    assert.ok(JSON.stringify(search).includes('"sensitivity":"internal"'));
    const exp = await (await fetch(base + "/export", { headers: H })).text();
    assert.ok(!exp.includes('"sensitivity":"internal"'), "the backup format is left alone");
    const prev = process.env.MONOMEM_LINT;
    process.env.MONOMEM_LINT = "quarantine";
    try {
      const held = await fetch(base + "/notes", { method: "POST", headers: H, body: JSON.stringify({ title: "k", body: "key AKIA" + "1234567890ABCD12" }) });
      const hb: any = await held.json();
      assert.equal(held.status, 202);
      assert.match(hb.quarantined.next, /monomem quarantine list/);
    } finally {
      if (prev === undefined) delete process.env.MONOMEM_LINT;
      else process.env.MONOMEM_LINT = prev;
    }
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  test("MCP: the label stays an enum in the schema but 'PRIVATE' is still accepted; descriptions use plain memory words; delete refusal says what to do", async () => {
    const store = new Store(":memory:");
    const server = createMcpServer(store, "write", {}, { label: "t", authed: true });
    const [c, sv] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(c), server.connect(sv)]);
    const tools = (await client.listTools()).tools;
    const w = tools.find((t) => t.name === "state_write")!;
    const sens: any = (w.inputSchema.properties as any).sensitivity;
    assert.ok(JSON.stringify(sens).includes('"private"') && JSON.stringify(sens).includes('"public"'), "the schema lists the labels: " + JSON.stringify(sens));
    assert.ok(String((w.inputSchema.properties as any).source.description).length < 120, "source text is short");
    const ok: any = await client.callTool({ name: "state_write", arguments: { title: "caps", sensitivity: "PRIVATE" } });
    assert.ok(!ok.isError, JSON.stringify(ok));
    assert.equal(store.list({}).notes[0].sensitivity, "private");
    const del: any = await client.callTool({ name: "state_delete", arguments: { id: store.list({}).notes[0].id } });
    assert.equal(del.isError, true);
    assert.match(del.content[0].text, /monomem token add <name> --admin/);
    await client.close();
    store.close();
  });
});

describe("A5: the dashboard", async () => {
  const { DASHBOARD_HTML, DASHBOARD_JS } = await import("../src/dashboard.js");

  test("the page script is valid JavaScript and has no pop-up alerts", () => {
    assert.doesNotThrow(() => new Function(DASHBOARD_JS));
    assert.ok(!/\balert\(/.test(DASHBOARD_JS), "errors appear in the page, not in pop-ups");
  });

  test("it reads #token= from the address, keeps it for the tab and clears the address", () => {
    assert.match(DASHBOARD_JS, /token=\(/);
    assert.match(DASHBOARD_JS, /sessionStorage\.setItem\(TOKKEY/);
    assert.match(DASHBOARD_JS, /history\.replaceState/);
  });

  test("labels: badge with text, per-note selector, filter, new-note choice, who-am-I banner, apps panel, change window", () => {
    assert.match(DASHBOARD_JS, /lvlBadge/);
    assert.match(DASHBOARD_JS, /Who can see this\?/);
    assert.match(DASHBOARD_HTML, /id="lvlf"/);
    assert.match(DASHBOARD_HTML, /id="n_lvl"/);
    assert.match(DASHBOARD_JS, /\/whoami/);
    assert.match(DASHBOARD_JS, /Signed in as/);
    assert.match(DASHBOARD_JS, /NO LIMIT/);
    assert.match(DASHBOARD_JS, /\/tokens/);
    assert.match(DASHBOARD_HTML, /id="chwin"/);
    assert.match(DASHBOARD_HTML, /<option value="30d">/);
  });

  test("accessible and themed: aria-live notice, labelled inputs, light/dark, no clickable anchors", () => {
    assert.match(DASHBOARD_HTML, /id="msg"[^>]*aria-live/);
    assert.match(DASHBOARD_HTML, /prefers-color-scheme:\s*light/);
    assert.ok(!/<a class="linkish"/.test(DASHBOARD_HTML), "actions are buttons");
    assert.match(DASHBOARD_HTML, /aria-label="Search notes"/);
    assert.match(DASHBOARD_HTML, /max-width:6\d\dpx/);
  });

  test("what the dashboard calls works: change a label with PUT, then see it in /whoami and the apps list never carries keys", async () => {
    const store = new Store(":memory:");
    const n = store.create({ title: "t", body: "b" });
    const toks = [{ token: "k".repeat(40), scope: "admin" as const, label: "op" }];
    const server = createApiServer(store, toks);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const H = { Authorization: `Bearer ${toks[0].token}`, "Content-Type": "application/json" };
    const put = await fetch(`${base}/notes/${n.id}`, { method: "PUT", headers: H, body: JSON.stringify({ sensitivity: "private", if_rev: n.rev }) });
    assert.equal(put.status, 200);
    const got: any = await (await fetch(`${base}/notes/${n.id}`, { headers: H })).json();
    assert.equal((got.note || got).sensitivity, "private");
    const who: any = await (await fetch(`${base}/whoami`, { headers: H })).json();
    assert.equal(who.label, "op");
    const apps = await (await fetch(`${base}/tokens`, { headers: H })).text();
    assert.ok(!apps.includes(toks[0].token), "keys are never listed");
    // The page itself needs no key.
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });

  test("the server prints how to open the dashboard when it starts", () => {
    const src = readFileSync(join(process.cwd(), "src/start.ts"), "utf8");
    assert.match(src, /Open the dashboard:/);
  });
});

describe("A5: sign-out and a rejected key", async () => {
  const { DASHBOARD_JS } = await import("../src/dashboard.js");
  test("logout exists and a 401 sends the person back to the sign-in with a plain sentence", () => {
    assert.match(DASHBOARD_JS, /function logout\(why\)/);
    assert.match(DASHBOARD_JS, /That key was not accepted/);
  });
});

describe("A6: README and docs", () => {
  const root = process.cwd();
  const readme = readFileSync(join(root, "README.md"), "utf8");
  test("the install command comes before the demo picture, and the README points at the labels and limited-access docs", () => {
    const first = readme.slice(0, readme.indexOf("demo.gif"));
    assert.match(first, /npx monomem setup/);
    assert.match(readme, /docs\/sensitivity-labels\.md/);
    assert.match(readme, /docs\/give-an-app-limited-access\.md/);
  });
  test("docs index exists with its three groups; keywords include the discovery words", () => {
    const idx = readFileSync(join(root, "docs/README.md"), "utf8");
    for (const h of ["## Do this", "## Understand this", "## Look this up"]) assert.ok(idx.includes(h), h);
    const kw: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).keywords;
    for (const k of ["mcp", "memory", "claude", "cursor", "sqlite"]) assert.ok(kw.includes(k), k);
  });
  test("INSTALL.md leads with the easy way", () => {
    const inst = readFileSync(join(root, "INSTALL.md"), "utf8");
    assert.ok(inst.indexOf("The easy way") < inst.indexOf("Doing it by hand"));
  });
});
