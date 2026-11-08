// Round 3: reviewer findings. Hostile-input timing, host check, dry runs, token file hygiene, one-time sign-in,
// secret-looking text, doctor, per-command help, safety-report privacy, scrub wording.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { Store, ValidationError } from "../src/store.js";
import { createApiServer } from "../src/api.js";
import { findPii, scanPii } from "../src/pii.js";
import { lintContent } from "../src/lint.js";
import { findContradictions } from "../src/contradiction.js";
import { secretAssignments } from "../src/security.js";
import { hostAllowed, hostRefusal } from "../src/security.js";
import { mintLoginCode, redeemLoginCode } from "../src/login-code.js";
import { safetyChecks, renderSafetyHtml } from "../src/safety-report.js";
import { realEnv, DEFAULT_OPTIONS, detectClients, planFile } from "../src/setup.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const mk = (p: string): string => mkdtempSync(join(tmpdir(), p));
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});
const timed = (f: () => unknown): number => {
  const t = Date.now();
  f();
  return Date.now() - t;
};
const cli = (home: string, ...a: string[]): ReturnType<typeof spawnSync> => {
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), XDG_CONFIG_HOME: join(home, ".config"), MONOMEM_HOME: join(home, "data"), MONOMEM_TOKEN: "z".repeat(40) } as NodeJS.ProcessEnv;
  delete env.CLAUDE_CONFIG_DIR;
  return spawnSync(process.execPath, [CLI, ...a], { env, encoding: "utf8", timeout: 60_000 });
};

describe("R3-1: hostile text cannot make the scans slow", () => {
  const cases: Record<string, string> = {
    email: "a.".repeat(50000) + "@",
    ssn: "123-45-".repeat(50000),
    iban: "GB82_".repeat(30000),
    ibanLong: "GB82" + "A".repeat(100000),
    cards: "4111 ".repeat(30000),
    address: "12 " + "Aaaa ".repeat(30000),
    password: "password:" + " ".repeat(100000),
    manySecrets: "password: aaaaaa ".repeat(10000),
    dob: "born ".repeat(30000),
    at: "@".repeat(100000),
    digits: "1".repeat(100000),
  };
  for (const [name, text] of Object.entries(cases)) {
    test(`${name}: pii scan and the write-time linter each finish in under 500 ms`, () => {
      assert.ok(timed(() => findPii(text)) < 500, "pii");
      assert.ok(timed(() => lintContent({ body: text })) < 500, "lint");
    });
  }
  test("the contradiction check and the scan loop respect their budgets on big input", () => {
    const notes = Array.from({ length: 3000 }, (_, i) => ({ id: i + 1, namespace: "d", title: "t" + i, body: "x ".repeat(5000), tags: [], updated_at: new Date().toISOString(), created_at: "" })) as never[];
    assert.ok(timed(() => findContradictions(notes)) < 6000);
    assert.ok(timed(() => scanPii(notes, 500, 1000)) < 1500, "scanPii gives up at its time budget");
  });
  test("only the first 16 KB of a note is read, hits are capped, and email masks hide the tail", () => {
    assert.equal(findPii("x".repeat(20000) + " jo@example.com").length, 0);
    assert.equal(findPii("jo@example.com ".repeat(500)).length, 50);
    const [h] = findPii("write to johnsmith@example.com");
    assert.match(h.masked, /^j\*+@example\.com$/);
    assert.ok(!h.masked.includes("ohnsmith"));
  });
  test("date of birth and plain-text passwords are found; placeholders and sentences are not", () => {
    const kinds = findPii("DOB: 1980-02-03 and born March 3, 1985; password: hunter2xyz").map((h) => h.kind).sort();
    assert.deepEqual(kinds, ["dob", "dob", "secret"]);
    for (const ok of ["password: <your password>", "password: xxxxxxxx", "the password: required for login", "pin: 1234", "api key: $API_KEY_VALUE"]) {
      assert.equal(secretAssignments(ok).length, 0, ok);
    }
    for (const bad of ["password: hunter2xyz", "pwd = changeme1", "api key: abc123def456", "secret: correcthorsebattery"]) {
      assert.equal(secretAssignments(bad).length, 1, bad);
    }
    assert.ok(!JSON.stringify(findPii("password: hunter2xyz")).includes("hunter"));
  });
});

describe("R3-7: secret-looking text is held at write time", () => {
  test("the store refuses 'password: ...' with a plain explanation and the way to override", () => {
    const s = new Store(":memory:");
    assert.throws(() => s.create({ title: "wifi", body: "the wifi password: hunter2xyz" }), (e: Error) => e instanceof ValidationError && /refusing to store/.test(e.message) && /MONOMEM_LINT=secrets=warn/.test(e.message));
    process.env.MONOMEM_LINT = "secrets=warn";
    assert.ok(s.create({ title: "wifi", body: "the wifi password: hunter2xyz" }).id > 0);
    delete process.env.MONOMEM_LINT;
    assert.ok(s.create({ title: "fine", body: "password: <your password here>" }).id > 0, "a placeholder is fine");
    s.close();
  });
});

describe("R3-2: the host check does not trust forwarding headers", () => {
  const req = (host: string, h: Record<string, string> = {}): never => ({ headers: { host, ...h } }) as never;
  test("X-Forwarded-For / X-Real-IP do not open the check; the refusal says exactly what to set", () => {
    assert.equal(hostAllowed(req("evil.example", { "x-forwarded-for": "1.1.1.1", "x-real-ip": "1.1.1.1" })), false);
    assert.equal(hostAllowed(req("evil.example", { "cf-connecting-ip": "1.1.1.1" })), false);
    assert.equal(hostAllowed(req("localhost:8790")), true);
    assert.equal(hostAllowed(req("10.0.0.5:8790")), true);
    assert.match(hostRefusal(req("my.tunnel.example:443")).hint, /MONOMEM_ALLOWED_HOSTS=my\.tunnel\.example/);
  });
});

describe("R3-3: connect --restricted --dry-run makes nothing", () => {
  test("no key is created, and a failed wiring takes the key back", () => {
    const home = mk("om-r3-dry-");
    try {
      const r = cli(home, "connect", "cursor", "--restricted", "--dry-run");
      assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
      assert.match(String(r.stdout), /nothing has been created/);
      assert.ok(!existsSync(join(home, "data", "tokens.json")), "no tokens.json");
      assert.ok(!existsSync(join(home, ".cursor", "mcp.json")), "no settings file");
      // A real run for an app whose wiring is refused leaves no key behind.
      const bad = cli(home, "connect", "zed", "--restricted", "--yes");
      assert.equal(bad.status, 0);
      const f = join(home, "data", "tokens.json");
      if (existsSync(f)) assert.equal((JSON.parse(readFileSync(f, "utf8")) as unknown[]).length, 1, "only the key that was printed for pasting");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("R3-6: connect replaces Monomem's own keyless entry", () => {
  test("it shows the change, writes a limited entry, and setup --undo puts the old one back", () => {
    const home = mk("om-r3-rep-");
    try {
      mkdirSync(join(home, ".cursor"), { recursive: true });
      const file = join(home, ".cursor", "mcp.json");
      const old = { mcpServers: { monomem: { command: "monomem", args: ["mcp"] } } };
      writeFileSync(file, JSON.stringify(old, null, 2));
      const r = cli(home, "connect", "cursor", "--restricted", "--yes");
      assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
      assert.ok(!/Monomem setup \(version/.test(String(r.stdout)), "the setup banner is not repeated");
      const after = JSON.parse(readFileSync(file, "utf8"));
      assert.match(after.mcpServers.monomem.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
      assert.equal(readdirBackups(join(home, ".cursor")) > 0, true, "a backup copy was saved beside the file");
      const u = cli(home, "setup", "--undo", "--yes");
      assert.equal(u.status, 0, String(u.stderr) + String(u.stdout));
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), old);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("an entry that already has its own key is not replaced silently", () => {
    const home = mk("om-r3-rep2-");
    try {
      const e = { ...realEnv("1.0.3", "/x/cli.js"), home, cwd: home, platform: "linux" as const, env: {} };
      mkdirSync(join(home, ".cursor"), { recursive: true });
      writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { monomem: { url: "http://x/mcp", headers: { Authorization: "Bearer k" } } } }));
      const opts = { ...DEFAULT_OPTIONS, only: ["cursor"], httpEntry: { url: "http://127.0.0.1:8791/mcp", headers: { Authorization: "Bearer n" } } };
      const p = planFile(e, opts, detectClients(e).find((t) => t.id === "cursor")!, { dbs: new Set() });
      assert.equal(p.change, null);
      assert.match(p.conflicts[0], /already connects this app with its own key/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
function readdirBackups(dir: string): number {
  return (JSON.stringify(spawnSync("ls", [dir], { encoding: "utf8" }).stdout).match(/monomem-backup/g) ?? []).length;
}

describe("R3-4/5: apps, the tokens file, and signing in", () => {
  const boot = async (tokens: Array<{ token: string; scope: "admin" | "write" | "read"; label: string; namespace?: string; max_sensitivity?: "public" | "internal" | "private" }>) => {
    const s = new Store(":memory:");
    const server = createApiServer(s, tokens as never);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (t: string, p: string, init: RequestInit = {}): Promise<Response> => fetch(base + p, { ...init, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    return { s, base, call, close: async (): Promise<void> => { await new Promise<void>((r) => server.close(() => r())); s.close(); } };
  };
  const ADMIN = "a".repeat(40), CAPPED = "c".repeat(40), PINNED = "p".repeat(40);

  test("no_limit makes a real no-limit key only for a caller that has no limit; the default stays internal", async () => {
    const { DATA_DIR: dir } = await import("../src/config.js"); // fixed when the program starts: the suite's throwaway folder
    try {
      const a = await boot([{ token: ADMIN, scope: "admin", label: "primary" }, { token: CAPPED, scope: "admin", label: "capped", max_sensitivity: "internal" }, { token: PINNED, scope: "admin", label: "pinned", namespace: "work" }]);
      const dflt = await (await a.call(ADMIN, "/tokens", { method: "POST", body: JSON.stringify({ label: "r3-default" }) })).json() as { app: { max_sensitivity: string | null } };
      assert.equal(dflt.app.max_sensitivity, "internal");
      const nolim = await a.call(ADMIN, "/tokens", { method: "POST", body: JSON.stringify({ label: "r3-nolimit", no_limit: true }) });
      assert.equal(nolim.status, 201);
      const j = await nolim.json() as { app: { max_sensitivity: string | null }; token: string; access: string };
      assert.equal(j.app.max_sensitivity, null);
      assert.match(j.access, /no limit/);
      // it works at once, and it is NOT the primary key
      const who = await (await a.call(j.token, "/whoami")).json() as { label: string; max_sensitivity?: string };
      assert.equal(who.label, "r3-nolimit");
      assert.ok(who.max_sensitivity == null);
      assert.equal((await a.call(ADMIN, "/tokens", { method: "POST", body: JSON.stringify({ label: "both", no_limit: true, max: "public" }) })).status, 400);
      assert.equal((await a.call(CAPPED, "/tokens", { method: "POST", body: JSON.stringify({ label: "sneaky", no_limit: true }) })).status, 403);
      assert.equal((await a.call(PINNED, "/tokens", { method: "POST", body: JSON.stringify({ label: "sneaky2", no_limit: true }) })).status, 403);
      // removal cuts it off at once, and the secret is not left in a backup copy
      assert.equal((await a.call(ADMIN, "/tokens/r3-nolimit", { method: "DELETE" })).status, 200);
      assert.equal((await a.call(j.token, "/whoami")).status, 401);
      const bak = join(dir, "tokens.json.bak");
      assert.ok(!existsSync(bak) || !readFileSync(bak, "utf8").includes(j.token), "revoked key is not in tokens.json.bak");
      assert.ok(!readFileSync(join(dir, "tokens.json"), "utf8").includes(j.token));
      if (process.platform !== "win32") assert.equal(statSync(join(dir, "tokens.json")).mode & 0o077, 0, "tokens.json is private to the user");
      // a malformed escape is a 400, not a crash
      assert.equal((await a.call(ADMIN, "/tokens/%E0%A4%A", { method: "DELETE" })).status, 400);
      // the dashboard no longer claims what it does not do
      const { DASHBOARD_JS } = await import("../src/dashboard.js");
      assert.ok(!/sees everything \(no limit\)/.test(DASHBOARD_JS));
      assert.match(DASHBOARD_JS, /no_limit = true/);
      await a.close();
    } finally {
      for (const f of ["tokens.json", "tokens.json.bak"]) rmSync(join(dir, f), { force: true });
    }
  });

  test("/audit and /insights are refused for limited AND namespace-pinned callers", async () => {
    const a = await boot([{ token: ADMIN, scope: "admin", label: "primary" }, { token: CAPPED, scope: "admin", label: "capped", max_sensitivity: "internal" }, { token: PINNED, scope: "admin", label: "pinned", namespace: "work" }]);
    for (const p of ["/audit", "/insights"]) {
      assert.equal((await a.call(ADMIN, p)).status, 200, p);
      assert.equal((await a.call(CAPPED, p)).status, 403, p);
      assert.equal((await a.call(PINNED, p)).status, 403, p);
    }
    await a.close();
  });

  test("the name 'primary' is reserved: a tokens.json entry using it is ignored", async () => {
    const { DATA_DIR: dir } = await import("../src/config.js");
    try {
      writeFileSync(join(dir, "tokens.json"), JSON.stringify([{ token: "q".repeat(40), scope: "admin", label: "Primary" }, { token: "r".repeat(40), scope: "read", label: "ok" }]));
      const { resolveTokens } = await import("../src/config.js");
      process.env.MONOMEM_TOKEN = "m".repeat(40);
      const labels = resolveTokens().map((t) => t.label);
      assert.ok(!resolveTokens().some((t) => t.token === "q".repeat(40)), "the impostor is not accepted");
      assert.ok(labels.includes("ok"));
    } finally {
      rmSync(join(dir, "tokens.json"), { force: true });
    }
  });

  test("two changes at once do not lose one, and a read-only data folder gives a plain message", async () => {
    const { DATA_DIR: dir } = await import("../src/config.js");
    try {
      const ta = await import("../src/tokens-admin.js");
      const names = ["one", "two", "three", "four", "five"];
      await Promise.all(names.map((n) => Promise.resolve().then(() => ta.addApp({ label: "lk-" + n }))));
      assert.equal(ta.listApps().filter((x) => x.label.startsWith("lk-")).length, 5);
      assert.ok(!existsSync(join(dir, "tokens.json.lock")), "the lock is released");
      if (process.platform !== "win32" && process.getuid?.() !== 0) {
        const ro = mk("om-r3-ro-");
        mkdirSync(join(ro, "data"));
        spawnSync("chmod", ["500", join(ro, "data")]);
        const r = cli(ro, "token", "add", "x");
        spawnSync("chmod", ["700", join(ro, "data")]);
        assert.ok(!/EACCES/.test(String(r.stderr)), String(r.stderr));
        rmSync(ro, { recursive: true, force: true });
      }
    } finally {
      for (const f of ["tokens.json", "tokens.json.bak"]) rmSync(join(dir, f), { force: true });
    }
  });

  test("the sign-in code works once, expires, and `monomem open --print` never shows the key", async () => {
    const { DATA_DIR: dir } = await import("../src/config.js");
    try {
      const code = mintLoginCode();
      assert.equal(redeemLoginCode(code), true);
      assert.equal(redeemLoginCode(code), false, "single use");
      const c2 = mintLoginCode(1000);
      assert.equal(redeemLoginCode(c2, 1000 + 61_000), false, "expired after 60 seconds");
      const c3 = mintLoginCode();
      assert.equal(redeemLoginCode("0".repeat(32)), false);
      assert.equal(redeemLoginCode(c3), false, "a wrong guess spends the code");
      // the endpoint
      const a = await boot([{ token: ADMIN, scope: "admin", label: "primary" }]);
      const good = mintLoginCode();
      const r = await fetch(a.base + "/login", { method: "POST", body: JSON.stringify({ code: good }) });
      assert.equal(r.status, 200);
      assert.equal(typeof ((await r.json()) as { token: string }).token, "string");
      assert.equal((await fetch(a.base + "/login", { method: "POST", body: JSON.stringify({ code: good }) })).status, 401);
      await a.close();
      // the CLI
      const home = mk("om-r3-open-");
      const o = cli(home, "open", "--print");
      const out = String(o.stdout);
      assert.match(out, /#code=[0-9a-f]{32}/);
      assert.ok(!out.includes("z".repeat(40)) && !/token=/.test(out), "the key is not in the address");
      rmSync(home, { recursive: true, force: true });
    } finally {
      rmSync(join(dir, "login-code"), { force: true });
    }
  });
});

describe("R3-5: the safety report names nothing", () => {
  test("no app names, namespace names or addresses in the page", async () => {
    const s = new Store(":memory:");
    const checks = await safetyChecks({
      store: s, dbPath: ":memory:", dataDir: tmpdir(), bindHost: "192.168.77.12",
      tokens: [{ token: "t".repeat(40), scope: "write", label: "acme-secret-app", namespace: "client-zeta" }] as never,
      version: "1.0.3", node: "22", platform: "linux",
    });
    const html = renderSafetyHtml(checks, { version: "1.0.3", date: "2026-11-08", node: "22", platform: "linux" });
    for (const leak of ["acme-secret-app", "client-zeta", "192.168.77.12"]) assert.ok(!html.includes(leak), leak);
    assert.match(html, /counts and yes\/no settings only/);
    s.close();
  });
});

describe("R3-5/10: scrub wording, per-command help, rules import, token text", () => {
  test("scrub says on line 1 that it does not remove personal data, and --yes warns the backup keeps the old text", () => {
    const home = mk("om-r3-scrub-");
    try {
      const d = cli(home, "scrub");
      assert.match(String(d.stdout).split("\n")[0], /does NOT remove personal data/);
      const y = cli(home, "purge-deleted", "--yes", "--out", join(home, "bk"));
      assert.equal(y.status, 0, String(y.stderr));
      assert.match(String(y.stdout), /backup it just made still CONTAINS the old text/);
      assert.match(String(y.stdout), new RegExp(join(home, "bk").replace(/[\\/]/g, ".")));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("--help on any command prints that command's usage, never a raw parser error", () => {
    const home = mk("om-r3-help-");
    try {
      for (const c of ["scrub", "pii", "health", "digest", "safety-report", "audit", "snippet", "demo", "import", "token", "connect", "open", "doctor", "bench"]) {
        const r = cli(home, c, "--help");
        assert.equal(r.status, 0, c + String(r.stderr));
        assert.match(String(r.stdout), new RegExp("^monomem " + c), c);
        assert.ok(!/ERR_PARSE_ARGS|Unknown option/.test(String(r.stderr) + String(r.stdout)), c);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("import --rules with a file says it wants a folder", () => {
    const home = mk("om-r3-rules-");
    try {
      writeFileSync(join(home, "AGENTS.md"), "# a\nb\n");
      const r = cli(home, "import", "--rules", join(home, "AGENTS.md"));
      assert.equal(r.status, 1);
      assert.match(String(r.stderr), /wants a project FOLDER/);
      assert.match(String(r.stderr), /--project/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("token add tells the truth about where the key is kept", () => {
    // The command itself needs a person at a terminal; its text is built by addedReport, which is what is checked here.
    const home = mk("om-r3-tadd-");
    try {
      const mod = pathToFileURL(fileURLToPath(new URL("../src/tokens-admin.js", import.meta.url))).href;
      const run = (opts: string, noLimit: boolean) =>
        spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `const t = await import(process.argv[1]); console.log(t.addedReport(t.addApp(${opts}), ${noLimit}));`, mod], {
          env: { ...process.env, MONOMEM_HOME: home, MONOMEM_TOKEN: "t".repeat(40) },
          encoding: "utf8",
        });
      const r = run('{ label: "tx", max: "internal" }', false);
      assert.equal(r.status, 0, String(r.stderr));
      assert.match(String(r.stdout), /plain text/);
      assert.ok(!/Monomem keeps it/.test(String(r.stdout)));
      const n = run('{ label: "nolim", noLimit: true }', true);
      assert.match(String(n.stdout), /NO LIMIT/);
      assert.match(String(n.stdout), /WARNING/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("R3-9: doctor", () => {
  test("a healthy fresh machine gets a plain all-clear and no stray lines; Claude Code absent means no hook warning", () => {
    const home = mk("om-r3-doc-");
    try {
      const r = cli(home, "doctor");
      const out = String(r.stdout);
      assert.equal(r.status, 0, out + String(r.stderr));
      assert.match(out, /Verdict: All good/);
      assert.ok(!/Generated new bearer token/.test(String(r.stderr)), "no stray key-creation line");
      assert.ok(!/recall failed/.test(String(r.stderr)));
      assert.ok(!/\[warn\]/.test(out), out);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("a corrupt tokens.json is a FAIL naming the file", () => {
    const home = mk("om-r3-doc2-");
    try {
      mkdirSync(join(home, "data"), { recursive: true });
      writeFileSync(join(home, "data", "tokens.json"), "{ not json");
      const r = cli(home, "doctor");
      assert.equal(r.status, 1);
      assert.match(String(r.stdout), /\[FAIL\].*tokens\.json cannot be read/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("a data folder that cannot be created gives a permissions hint, not 'set MONOMEM_TOKEN'", () => {
    if (process.platform === "win32") return;
    const home = mk("om-r3-doc3-");
    try {
      spawnSync("chmod", ["500", home]);
      if (spawnSync("sh", ["-c", `touch '${join(home, "probe")}'`]).status === 0) return; // this file system ignores permissions
      const r = cli(home, "doctor");
      spawnSync("chmod", ["700", home]);
      assert.match(String(r.stdout), /permission/i);
      assert.ok(!/Set MONOMEM_TOKEN to a long random value/.test(String(r.stdout)));
      spawnSync("chmod", ["500", home]);
      const mod = pathToFileURL(fileURLToPath(new URL("../src/tokens-admin.js", import.meta.url))).href;
      const t = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", `const t = await import(process.argv[1]); try { t.addApp({ label: "x" }); } catch (e) { console.error(e.message); process.exit(1); }`, mod], { env: { ...process.env, MONOMEM_HOME: home, MONOMEM_TOKEN: "t".repeat(40) }, encoding: "utf8" });
      spawnSync("chmod", ["700", home]);
      assert.equal(t.status, 1);
      assert.ok(!/EACCES/.test(String(t.stderr)), String(t.stderr));
      assert.match(String(t.stderr), /permission denied/);
    } finally {
      spawnSync("chmod", ["700", home]);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("R3-8: dashboard on a phone", () => {
  test("tables fold into cards, the toolbar folds into a menu, and the sign-in text has no jargon or double period", async () => {
    const { DASHBOARD_HTML, DASHBOARD_JS } = await import("../src/dashboard.js");
    assert.match(DASHBOARD_HTML, /table\.apps td::before/);
    assert.ok(!/key file the server printed/.test(DASHBOARD_HTML));
    assert.match(DASHBOARD_HTML, /run <code>monomem open<\/code>/);
    assert.match(DASHBOARD_JS, /function stackTables/);
    assert.match(DASHBOARD_JS, /replace\(\/\[\.\\s\]\+\$\/, ""\)/);
  });
});
