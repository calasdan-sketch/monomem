// self.ts: "how do I launch myself" for the npm install, the bundled folder (own node.exe) and the single executable.
// Every mode is simulated through injected facts: no binary is built and nothing is spawned.
import "./setup-env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SELF_CLI, assetsRoot, modeFor, quoteShellArg, selfCommand, selfFacts, selfShellLine, selfVersion, serviceLaunch, type SelfFacts } from "../src/self.js";
import { buildCaptureCommand, buildHookCommand, buildServerEntry, type SetupEnv } from "../src/setup.js";
import { servicePlan } from "../src/service.js";

const win = (mode: SelfFacts["mode"], over: Partial<SelfFacts> = {}): SelfFacts => ({
  mode,
  execPath: mode === "sea" ? "C:\\Program Files\\Monomem\\monomem.exe" : mode === "bundle" ? "C:\\Program Files\\Monomem\\node.exe" : "C:\\Program Files\\nodejs\\node.exe",
  cliPath: mode === "sea" ? "C:\\Program Files\\Monomem\\monomem.exe" : "C:\\Program Files\\Monomem\\dist\\src\\cli.js",
  platform: "win32",
  ...over,
});
const posix = (mode: SelfFacts["mode"]): SelfFacts => ({
  mode,
  execPath: mode === "sea" ? "/opt/my apps/monomem" : "/usr/local/bin/node",
  cliPath: mode === "sea" ? "/opt/my apps/monomem" : "/home/me/my tools/monomem/dist/src/cli.js",
  platform: "linux",
});

describe("this process (npm layout: dist/src/cli.js run by node)", () => {
  test("is the npm mode, cli.js beside self.js, the version from package.json", () => {
    const f = selfFacts();
    assert.equal(f.mode, "npm");
    assert.equal(f.execPath, process.execPath);
    assert.equal(SELF_CLI, fileURLToPath(new URL("../src/cli.js", import.meta.url)));
    assert.equal(assetsRoot(), join(fileURLToPath(new URL("../src/", import.meta.url)), "..", ".."));
    assert.match(selfVersion(), /^\d+\.\d+\.\d+/);
    assert.equal(selfVersion(null), "0.0.0", "no package root and no build-time version: 0.0.0, never a throw");
  });
});

describe("modeFor", () => {
  test("a node inside the package folder is the bundled runtime; any other node is an npm install; node:sea wins", () => {
    // Native paths: path.relative parses only this OS's paths.
    const pkg = resolve("monomem-pkg");
    assert.equal(modeFor(false, resolve("nodejs", "node.exe"), pkg), "npm");
    assert.equal(modeFor(false, join(pkg, "runtime", "node.exe"), pkg), "bundle");
    assert.equal(modeFor(false, join(pkg + "-old", "node.exe"), pkg), "npm", "a sibling folder with a shared prefix is not inside");
    assert.equal(modeFor(true, "/opt/monomem/monomem", "/opt/monomem"), "sea");
  });
});

describe("selfCommand (spawn, no shell)", () => {
  test("npm and bundle: node + cli.js + args; sea: the executable + args (never the exe twice)", () => {
    assert.deepEqual(selfCommand(["start", "--log"], win("npm")), { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Program Files\\Monomem\\dist\\src\\cli.js", "start", "--log"] });
    assert.deepEqual(selfCommand(["mcp"], win("bundle")), { command: "C:\\Program Files\\Monomem\\node.exe", args: ["C:\\Program Files\\Monomem\\dist\\src\\cli.js", "mcp"] });
    assert.deepEqual(selfCommand(["mcp"], win("sea")), { command: "C:\\Program Files\\Monomem\\monomem.exe", args: ["mcp"] });
  });
  test("serviceLaunch: no cli for the executable", () => {
    assert.deepEqual(serviceLaunch(posix("npm")), { node: "/usr/local/bin/node", cli: "/home/me/my tools/monomem/dist/src/cli.js" });
    assert.deepEqual(serviceLaunch(posix("sea")), { node: "/opt/my apps/monomem" });
  });
});

describe("quoteShellArg", () => {
  test("Windows: forward slashes, always quoted; spaces, & and % stay literal inside the quotes; a quote is escaped", () => {
    assert.equal(quoteShellArg("C:\\Program Files\\x\\cli.js", "win32"), '"C:/Program Files/x/cli.js"');
    assert.equal(quoteShellArg("C:\\R&D\\cli.js", "win32"), '"C:/R&D/cli.js"');
    assert.equal(quoteShellArg("C:\\100%\\cli.js", "win32"), '"C:/100%/cli.js"');
    assert.equal(quoteShellArg('say "hi"', "win32"), '"say \\"hi\\""');
  });
  test("POSIX: spaces quoted; $ ` and \" escaped so the shell expands nothing", () => {
    assert.equal(quoteShellArg("/home/me/my tools/cli.js", "linux"), '"/home/me/my tools/cli.js"');
    assert.equal(quoteShellArg("/home/$USER/`x`/a\"b", "darwin"), '"/home/\\$USER/\\`x\\`/a\\"b"');
  });
});

describe("selfShellLine (hook command lines)", () => {
  test("npm: bare node + quoted cli.js, exactly as hooks have always been written", () => {
    assert.equal(selfShellLine("hook stop", win("npm")), 'node "C:/Program Files/Monomem/dist/src/cli.js" hook stop');
    assert.equal(selfShellLine("recall", posix("npm")), 'node "/home/me/my tools/monomem/dist/src/cli.js" recall');
  });
  test("bundle: the bundled node by absolute path (no Node on PATH)", () => {
    assert.equal(selfShellLine("hook stop", win("bundle")), '"C:/Program Files/Monomem/node.exe" "C:/Program Files/Monomem/dist/src/cli.js" hook stop');
  });
  test("sea: the executable alone; no `node \"` and no doubled path", () => {
    const line = selfShellLine("hook stop", win("sea"));
    assert.equal(line, '"C:/Program Files/Monomem/monomem.exe" hook stop');
    assert.equal(selfShellLine("", posix("sea")), '"/opt/my apps/monomem"');
  });
});

describe("setup routes through self.ts", () => {
  const env = (mode: SetupEnv["mode"], over: Partial<SetupEnv> = {}): SetupEnv => {
    const f = win(mode ?? "npm");
    return { home: "C:\\Users\\me", platform: "win32", env: {}, cwd: "C:\\Users\\me", nodeVersion: "24.18.0", execPath: f.execPath, cliPath: f.cliPath, version: "9.9.9", now: () => new Date(0), mode, ...over };
  };
  const opts = { command: "auto" as const };
  test("npm (mode absent or npm): unchanged entry and hook lines", () => {
    for (const e of [env(undefined), env("npm")]) {
      assert.deepEqual(buildServerEntry(e, opts), { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Program Files\\Monomem\\dist\\src\\cli.js", "mcp"] });
      assert.equal(buildHookCommand(e, opts, "C:\\Users\\me\\.monomem\\state.db"), 'node "C:/Program Files/Monomem/dist/src/cli.js" recall --budget-ms 800 --db "C:/Users/me/.monomem/state.db"');
      assert.equal(buildCaptureCommand(e, opts, "stop"), 'node "C:/Program Files/Monomem/dist/src/cli.js" hook stop');
    }
  });
  test("npx cache keeps npx, and still prefers a global install of the same version", () => {
    const npx = env("npm", { cliPath: "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\monomem\\dist\\src\\cli.js" });
    assert.deepEqual(buildServerEntry(npx, opts), { command: "cmd", args: ["/c", "npx", "-y", "monomem@9.9.9", "mcp"] });
    assert.equal(buildCaptureCommand(npx, opts, "stop"), "npx -y monomem@9.9.9 hook stop");
    assert.equal(buildCaptureCommand({ ...npx, globalCliPath: "C:\\npm\\monomem\\dist\\src\\cli.js" }, opts, "stop"), 'node "C:/npm/monomem/dist/src/cli.js" hook stop');
  });
  test("sea: entry is the executable alone; hooks never start with node", () => {
    const e = env("sea");
    assert.deepEqual(buildServerEntry(e, opts), { command: "C:\\Program Files\\Monomem\\monomem.exe", args: ["mcp"] });
    assert.equal(buildHookCommand(e, opts), '"C:/Program Files/Monomem/monomem.exe" recall --budget-ms 800');
    assert.equal(buildCaptureCommand(e, opts, "user-prompt"), '"C:/Program Files/Monomem/monomem.exe" hook user-prompt');
  });
  test("bundle: hooks name the bundled node", () => {
    assert.equal(buildCaptureCommand(env("bundle"), opts, "stop"), '"C:/Program Files/Monomem/node.exe" "C:/Program Files/Monomem/dist/src/cli.js" hook stop');
  });
});

describe("service plan from self.ts", () => {
  const base = { home: "/home/me", dataDir: "/home/me/.monomem", env: {} };
  test("the executable appears once in the systemd unit and the Windows task", () => {
    const sea = servicePlan({ ...base, platform: "linux", ...serviceLaunch(posix("sea")) });
    assert.match(sea.file.text, /^ExecStart="\/opt\/my apps\/monomem" "start" "--log"$/m);
    const task = servicePlan({ ...base, platform: "win32", dataDir: "C:\\Users\\me\\.monomem", ...serviceLaunch(win("sea")) });
    assert.match(task.file.text, /"C:\\Program Files\\Monomem\\monomem\.exe" start --log</);
    assert.doesNotMatch(task.file.text, /monomem\.exe" "C:/);
  });
});
