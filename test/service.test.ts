// 1.5.0 (round 2, U-16 / infra MED-4): `monomem service install|status|uninstall` keeps the server running in the background.
// These tests only GENERATE the unit text and the commands (servicePlan, `--print`); nothing is ever installed on the machine.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { servicePlan, serviceCmd, type ServiceEnv } from "../src/service.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const base = (platform: NodeJS.Platform, over: Partial<ServiceEnv> = {}): ServiceEnv => ({
  platform,
  node: platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/home/u/.nvm/versions/node/v24.1.0/bin/node",
  cli: platform === "win32" ? "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\monomem\\dist\\src\\cli.js" : "/home/u/.nvm/versions/node/v24.1.0/lib/node_modules/monomem/dist/src/cli.js",
  home: platform === "win32" ? "C:\\Users\\u" : platform === "darwin" ? "/Users/u" : "/home/u",
  dataDir: platform === "win32" ? "C:\\Users\\u\\.monomem" : "/home/u/.monomem",
  uid: 501,
  env: {},
  ...over,
});

describe("monomem service (U-16)", () => {
  test("Windows: a logon task whose action is the absolute node.exe with the absolute cli.js (never a .ps1/.cmd shim), restarted on failure", () => {
    const p = servicePlan(base("win32"));
    const cmd = /<Command>([^<]+)<\/Command>/.exec(p.file.text)![1];
    assert.match(cmd, /^[A-Z]:\\.*\\cmd\.exe$/i, "cmd.exe sets the carried settings, then runs node.exe");
    assert.match(p.file.text, /&amp;&amp; "C:\\Program Files\\nodejs\\node\.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\monomem\\dist\\src\\cli\.js" start --log<\/Arguments>/);
    assert.doesNotMatch(p.file.text, /\.ps1|\.cmd|monomem\.exe/);
    assert.match(p.file.text, /<LogonTrigger>/);
    assert.match(p.file.text, /<RestartOnFailure>/);
    assert.match(p.file.text, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(p.file.text, /<RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.deepEqual(p.install[0], ["schtasks", "/Create", "/TN", "Monomem", "/XML", p.file.path, "/F"]);
    assert.deepEqual(p.uninstall.at(-1), ["schtasks", "/Delete", "/TN", "Monomem", "/F"]);
    // A path with a space is quoted in the arguments.
    const spaced = servicePlan(base("win32", { cli: "C:\\My Apps\\monomem\\dist\\src\\cli.js" }));
    assert.match(spaced.file.text, / "C:\\My Apps\\monomem\\dist\\src\\cli\.js" start --log<\/Arguments>/);
  });

  test("Windows (release-gate S1): the task carries MONOMEM_HOME and the other settings, like macOS and Linux; no key", () => {
    const p = servicePlan(base("win32", { dataDir: "D:\\My Data & more\\mm", env: { MONOMEM_PORT: "9000", MONOMEM_TOKEN: "secret-should-not-appear", ComSpec: "C:\\Windows\\system32\\cmd.exe" } }));
    const args = /<Arguments>([^<]+)<\/Arguments>/.exec(p.file.text)![1];
    assert.equal(/<Command>([^<]+)<\/Command>/.exec(p.file.text)![1], "C:\\Windows\\system32\\cmd.exe");
    assert.ok(args.startsWith("/d /v:off /c "), args);
    assert.ok(args.includes('set "MONOMEM_HOME=D:\\My Data &amp; more\\mm"&amp;&amp; '), args);
    assert.ok(args.includes('set "MONOMEM_PORT=9000"&amp;&amp; '), args);
    assert.doesNotMatch(p.file.text, /secret-should-not-appear|MONOMEM_TOKEN/);
    // A value cmd would change (% expands even inside quotes) is not carried; the note says so.
    const pct = servicePlan(base("win32", { env: { MONOMEM_ALLOWED_HOSTS: "a%PATH%b" } }));
    assert.doesNotMatch(pct.file.text, /MONOMEM_ALLOWED_HOSTS/);
    assert.ok(pct.notes.some((n) => /MONOMEM_ALLOWED_HOSTS/.test(n) && /setx/.test(n)), pct.notes.join("\n"));
  });

  test("Windows: with every setting skipped (a % in the data folder), the command after /c still does not start with a quote", () => {
    // cmd /c strips the first and last quote of a line that starts with one and holds more than two: a quoted node.exe
    // plus a quoted cli.js path with a space would then break the task.
    const p = servicePlan(base("win32", { dataDir: "C:\\Users\\u\\100%data", cli: "C:\\My Apps\\monomem\\dist\\src\\cli.js" }));
    const args = /<Arguments>([^<]+)<\/Arguments>/.exec(p.file.text)![1];
    assert.doesNotMatch(args, /MONOMEM_HOME/);
    assert.ok(!/\/c "/.test(args), args);
    assert.ok(args.includes('"C:\\Program Files\\nodejs\\node.exe" "C:\\My Apps\\monomem\\dist\\src\\cli.js" start --log'), args);
  });

  test("final-security SF4: install with a non-loopback bind needs a person at a terminal (refused from a script, nothing run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-svc-gate-"));
    try {
      // PATH is an empty folder: even if the gate failed, no schtasks/launchctl/systemctl could be found and run.
      const env = { ...process.env, PATH: dir, Path: dir, HOME: dir, USERPROFILE: dir, MONOMEM_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, ".config"), MONOMEM_BIND: "0.0.0.0" };
      const r = spawnSync(process.execPath, ["--no-warnings", CLI, "service", "install"], { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stderr, /Refused: service install/);
      for (const f of [join(dir, "data", "monomem-task.xml"), join(dir, "Library", "LaunchAgents", "io.monomem.server.plist"), join(dir, ".config", "systemd", "user", "monomem.service")]) {
        assert.equal(existsSync(f), false, `wrote ${f}`);
      }
      const print = spawnSync(process.execPath, ["--no-warnings", CLI, "service", "install", "--print"], { env, encoding: "utf8" });
      assert.equal(print.status, 0, "--print changes nothing, so it is not gated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("macOS: a LaunchAgent with absolute node + cli.js, KeepAlive, and the data folder; no key in it", () => {
    const p = servicePlan(base("darwin", { env: { MONOMEM_PORT: "9000", MONOMEM_TOKEN: "secret-should-not-appear" } }));
    assert.equal(p.file.path, "/Users/u/Library/LaunchAgents/io.monomem.server.plist".replace(/\//g, join("a", "b")[1]));
    assert.match(p.file.text, /<key>ProgramArguments<\/key><array><string>\/home\/u\/\.nvm\/versions\/node\/v24\.1\.0\/bin\/node<\/string><string>\/home\/u\/.*\/cli\.js<\/string><string>start<\/string><string>--log<\/string><\/array>/);
    assert.match(p.file.text, /<key>KeepAlive<\/key><true\/>/);
    assert.match(p.file.text, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(p.file.text, /<key>MONOMEM_HOME<\/key><string>\/home\/u\/\.monomem<\/string>/);
    assert.match(p.file.text, /<key>MONOMEM_PORT<\/key><string>9000<\/string>/);
    assert.doesNotMatch(p.file.text, /secret-should-not-appear|MONOMEM_TOKEN/);
    assert.deepEqual(p.install, [["launchctl", "bootstrap", "gui/501", p.file.path]]);
  });

  test("Linux: a systemd --user unit with absolute node + cli.js (works with nvm), Restart=always, no ProtectHome", () => {
    const p = servicePlan(base("linux"));
    assert.equal(p.file.path, join("/home/u", ".config", "systemd", "user", "monomem.service"));
    assert.match(p.file.text, /^ExecStart="\/home\/u\/\.nvm\/versions\/node\/v24\.1\.0\/bin\/node" "\/home\/u\/.*\/cli\.js" "start" "--log"$/m);
    assert.match(p.file.text, /^Environment="MONOMEM_HOME=\/home\/u\/\.monomem"$/m);
    assert.match(p.file.text, /^Restart=always$/m);
    assert.match(p.file.text, /^WantedBy=default\.target$/m);
    assert.doesNotMatch(p.file.text, /ProtectHome/);
    assert.deepEqual(p.install.slice(1), [["systemctl", "--user", "enable", "monomem.service"], ["systemctl", "--user", "restart", "monomem.service"]]);
  });

  test("`monomem service install --print` shows the file and commands and writes nothing; setup never mentions installing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mm-svc-"));
    try {
      const env = { ...process.env, HOME: dir, USERPROFILE: dir, MONOMEM_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, ".config") };
      const r = spawnSync(process.execPath, ["--no-warnings", CLI, "service", "install", "--print"], { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Would write /);
      assert.match(r.stdout, /Would run:/);
      assert.ok(r.stdout.includes(process.execPath), "the real node binary, absolute");
      assert.ok(r.stdout.includes(CLI), "the real cli.js, absolute");
      for (const f of [join(dir, "data", "monomem-task.xml"), join(dir, "Library", "LaunchAgents", "io.monomem.server.plist"), join(dir, ".config", "systemd", "user", "monomem.service")]) {
        assert.equal(existsSync(f), false, `--print wrote ${f}`);
      }
      const bad = spawnSync(process.execPath, ["--no-warnings", CLI, "service", "start"], { env, encoding: "utf8" });
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /monomem service install\|status\|uninstall/);
      const setupSrc = readFileSync(fileURLToPath(new URL("../src/setup.js", import.meta.url)), "utf8");
      assert.doesNotMatch(setupSrc, /service\.js|serviceCmd|schtasks|launchctl|systemctl/, "setup never installs a service");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("final3 INFRA-S1..S4: the Windows task and re-running install", () => {
  test("S1: node and cli.js are always quoted, so & and ^ in a path without a space stay literal; % or a quote in them is refused", () => {
    const p = servicePlan(base("win32", { cli: "C:\\Users\\R&D\\npm\\cli.js" }));
    assert.ok(p.file.text.includes('"C:\\Users\\R&amp;D\\npm\\cli.js" start --log</Arguments>'), p.file.text);
    assert.equal(p.refuse, undefined);
    for (const bad of [{ cli: "C:\\p%PATH%q\\cli.js" }, { node: 'C:\\a"b\\node.exe' }]) {
      assert.match(servicePlan(base("win32", bad)).refuse ?? "", /% or a quote/);
    }
  });

  test("S1 (win32 only): the generated line, run through cmd.exe as Task Scheduler does, reaches node with the right path for R&D and a^b", { skip: process.platform !== "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "mm-svc-cmd-"));
    try {
      for (const name of ["R&D", "a^b"]) {
        const dir = join(root, name);
        mkdirSync(dir);
        const out = join(root, `${name.replace(/\W/g, "_")}.json`);
        writeFileSync(join(dir, "cli.js"), `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(1), home: process.env.MONOMEM_HOME }));`);
        const p = servicePlan(base("win32", { node: process.execPath, cli: join(dir, "cli.js"), dataDir: join(root, "data"), env: { ComSpec: process.env.ComSpec } }));
        const xmlText = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        const cmd = xmlText(/<Command>([^<]+)<\/Command>/.exec(p.file.text)![1]);
        const args = xmlText(/<Arguments>([^<]+)<\/Arguments>/.exec(p.file.text)![1]);
        const r = spawnSync(cmd, [args], { windowsVerbatimArguments: true, encoding: "utf8", windowsHide: true });
        assert.ok(existsSync(out), `${name}: ${r.stdout}${r.stderr}`);
        const got = JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; home: string };
        assert.deepEqual(got.argv, [join(dir, "cli.js"), "start", "--log"]);
        assert.equal(got.home, join(root, "data"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S2: the logon trigger and the principal name this user, so a non-admin can register it and it starts only at your sign-in", () => {
    const p = servicePlan(base("win32", { env: { USERDOMAIN: "DESK", USERNAME: "R&D" } }));
    assert.match(p.file.text, /<LogonTrigger>[\s\S]*<UserId>DESK\\R&amp;D<\/UserId>[\s\S]*<\/LogonTrigger>/);
    assert.match(p.file.text, /<Principal id="Author"><UserId>DESK\\R&amp;D<\/UserId>/);
    assert.doesNotMatch(servicePlan(base("win32")).file.text, /<UserId>/, "no user name known: no guessing");
  });

  test("S3: a 5-minute repeat starts it again after a crash or a closed window; the note says 5 minutes, not a minute", () => {
    const p = servicePlan(base("win32"));
    assert.match(p.file.text, /<LogonTrigger><Repetition><Interval>PT5M<\/Interval><StopAtDurationEnd>false<\/StopAtDurationEnd><\/Repetition>/);
    assert.match(p.file.text, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.ok(p.notes.some((n) => /within 5 minutes/.test(n)), p.notes.join("\n"));
    assert.ok(!p.notes.some((n) => /within a minute/.test(n)));
  });

  test("S4: running install again (after an upgrade) restarts a running server on every OS", () => {
    const w = servicePlan(base("win32"));
    assert.deepEqual(w.preInstall, [["schtasks", "/End", "/TN", "Monomem"]]);
    assert.deepEqual(w.install.at(-1), ["schtasks", "/Run", "/TN", "Monomem"]);
    const m = servicePlan(base("darwin"));
    assert.deepEqual(m.preInstall, [["launchctl", "bootout", "gui/501/io.monomem.server"]]);
    assert.deepEqual(m.install, [["launchctl", "bootstrap", "gui/501", m.file.path]]);
    const l = servicePlan(base("linux"));
    assert.deepEqual(l.install.at(-1), ["systemctl", "--user", "restart", "monomem.service"]);
  });
test("final4 infra L8: macOS retries bootstrap once after 1 s when it fails right after bootout (injected runner)", () => {
    const home = mkdtempSync(join(tmpdir(), "om-svc-mac-"));
    try {
      const e = base("darwin", { home, dataDir: join(home, ".monomem") });
      const calls: string[] = [];
      const waits: number[] = [];
      let fails = 1;
      const runner = (c: string[]): boolean => {
        calls.push(c.slice(0, 2).join(" "));
        return !(c[1] === "bootstrap" && fails-- > 0);
      };
      assert.equal(serviceCmd("install", false, e, { run: runner, sleep: (ms) => void waits.push(ms) }), 0);
      assert.deepEqual(calls, ["launchctl bootout", "launchctl bootstrap", "launchctl bootstrap"]);
      assert.deepEqual(waits, [1000]);
      // Fails twice: one retry only, and install says it failed.
      calls.length = 0;
      waits.length = 0;
      fails = 2;
      assert.equal(serviceCmd("install", false, e, { run: runner, sleep: (ms) => void waits.push(ms) }), 1);
      assert.deepEqual(calls, ["launchctl bootout", "launchctl bootstrap", "launchctl bootstrap"]);
      // Other OSes never retry.
      calls.length = 0;
      waits.length = 0;
      const l = base("linux", { home, dataDir: join(home, ".monomem"), env: { XDG_CONFIG_HOME: join(home, ".config") } });
      assert.equal(serviceCmd("install", false, l, { run: (c) => (calls.push(c.slice(0, 3).join(" ")), c[2] !== "daemon-reload"), sleep: (ms) => void waits.push(ms) }), 1);
      assert.deepEqual(calls, ["systemctl --user daemon-reload"]);
      assert.deepEqual(waits, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

