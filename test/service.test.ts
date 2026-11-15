// 1.5.0 (round 2, U-16 / infra MED-4): `monomem service install|status|uninstall` keeps the server running in the background.
// These tests only GENERATE the unit text and the commands (servicePlan, `--print`); nothing is ever installed on the machine.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { servicePlan, type ServiceEnv } from "../src/service.js";

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
    assert.match(p.file.text, /&amp;&amp; "C:\\Program Files\\nodejs\\node\.exe" C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\monomem\\dist\\src\\cli\.js start --log<\/Arguments>/);
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
    assert.deepEqual(p.install.at(-1), ["systemctl", "--user", "enable", "--now", "monomem.service"]);
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
