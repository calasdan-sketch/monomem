// The standalone download (bundle mode: the official node + Monomem's code in one folder): its home on this computer, the
// Start menu / Applications entry setup adds, `monomem update` (checksum, rename-aside swap with rollback, offline-safe)
// and the no-command launch. Everything runs in temp folders with injected network and process calls.
import "./setup-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync as renameReal, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assetName, cleanupOld, isNewer, parseSums, restartServerAfterUpdate, runUpdate, swapIn, targetOf, type RestartDeps, type UpdateDeps } from "../src/update.js";
import { bundleRoot, copyToInstall, installDir, samePath, shortcutPlan } from "../src/install.js";
import { DEFAULT_OPTIONS, readHistory, runSetup, type SetupEnv, type SetupIO } from "../src/setup.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.js");
const REPO = join(HERE, "..", "..");
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const scratch = (): string => {
  const r = mkdtempSync(join(tmpdir(), "mm-dist-"));
  roots.push(r);
  return r;
};
const put = (p: string, s: string): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};
/** A fake unpacked Monomem folder: what update and setup look at (no real runtime needed). */
const fakeBundle = (root: string, version: string, platform: NodeJS.Platform = "linux"): string => {
  put(join(root, "runtime", platform === "win32" ? "node.exe" : "node"), `node for ${version}`);
  put(join(root, "dist", "src", "cli.js"), `// monomem ${version}`);
  put(join(root, "package.json"), JSON.stringify({ name: "monomem", version }));
  put(join(root, "docs", "a.md"), version);
  return root;
};

describe("names and versions", () => {
  test("download targets and archive names match the build script", async () => {
    assert.equal(targetOf("win32", "x64"), "win-x64");
    assert.equal(targetOf("darwin", "arm64"), "darwin-arm64");
    assert.equal(targetOf("linux", "x64"), "linux-x64");
    assert.equal(targetOf("linux", "arm64"), null);
    const build = (await import(pathToFileURL(join(REPO, "scripts", "build-bundle.mjs")).href)) as { archiveName(v: string, t: string): string; TARGETS: string[] };
    for (const t of build.TARGETS) assert.equal(assetName("1.6.0", t), build.archiveName("1.6.0", t));
    assert.equal(assetName("1.6.0", "win-x64"), "monomem-1.6.0-win-x64.zip");
    assert.equal(assetName("1.6.0", "linux-x64"), "monomem-1.6.0-linux-x64.tar.gz");
  });
  test("SHA256SUMS lines and version order", () => {
    const h = "a".repeat(64);
    const m = parseSums(`${h}  monomem-1.6.0-win-x64.zip\r\n${"B".repeat(64)} *monomem-1.6.0-linux-x64.tar.gz\nnot a line\n`);
    assert.equal(m.get("monomem-1.6.0-win-x64.zip"), h);
    assert.equal(m.get("monomem-1.6.0-linux-x64.tar.gz"), "b".repeat(64));
    assert.equal(m.size, 2);
    assert.ok(isNewer("1.6.0", "1.5.9") && isNewer("1.10.0", "1.9.0") && isNewer("v2.0.0", "1.99.99"));
    assert.ok(!isNewer("1.6.0", "1.6.0") && !isNewer("1.5.0", "1.6.0"));
    assert.ok(isNewer("1.6.0", "1.6.0-rc.1") && !isNewer("1.6.0-rc.1", "1.6.0"));
    // semver: numeric pre-release parts compare as numbers, numbers sort before words, more parts sort after fewer
    assert.ok(isNewer("1.6.0-rc.10", "1.6.0-rc.9") && !isNewer("1.6.0-rc.9", "1.6.0-rc.10"));
    assert.ok(isNewer("1.6.0-rc.1", "1.6.0-beta.2") && isNewer("1.6.0-alpha", "1.6.0-1") && isNewer("1.6.0-rc.1.1", "1.6.0-rc.1"));
    assert.ok(!isNewer("1.6.0-rc.1", "1.6.0-rc.1"));
  });
});

describe("home folder and the app entry", () => {
  test("per user, no admin rights, one per platform", () => {
    assert.equal(installDir({ platform: "win32", home: "C:\\Users\\a", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } }), join("C:\\Users\\a\\AppData\\Local", "Programs", "Monomem"));
    assert.equal(installDir({ platform: "darwin", home: "/Users/a", env: {} }), join("/Users/a", "Applications", "Monomem"));
    assert.equal(installDir({ platform: "linux", home: "/home/a", env: {} }), join("/home/a", ".local", "share", "monomem"));
    assert.equal(installDir({ platform: "linux", home: "/home/a", env: { XDG_DATA_HOME: "/data" } }), join("/data", "monomem"));
    assert.equal(bundleRoot(join("/x", "Monomem", "dist", "src", "cli.js")), resolve("/x", "Monomem"));
  });
  test("the entry opens the dashboard through the installed runtime", () => {
    const lin = shortcutPlan({ platform: "linux", home: "/home/a", env: {} }, "/home/a/.local/share/monomem");
    assert.equal(lin.file, join("/home/a", ".local", "share", "applications", "monomem.desktop"));
    assert.match(lin.text!, /^Exec=".*runtime[\\/]+node" ".*cli\.js" open$/m);
    assert.match(lin.text!, /^Terminal=false$/m);
    const mac = shortcutPlan({ platform: "darwin", home: "/Users/a", env: {} }, "/Users/a/Applications/Monomem");
    assert.equal(mac.createdDir, join("/Users/a", "Applications", "Monomem.app"));
    assert.match(mac.text!, /^#!\/bin\/sh\nexec ".*runtime[\\/]+node" ".*cli\.js" open\n$/);
    const win = shortcutPlan({ platform: "win32", home: "C:\\Users\\a", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" } }, "C:\\Users\\a\\AppData\\Local\\Programs\\Monomem");
    assert.match(win.file, /Start Menu[\\/]Programs[\\/]Monomem\.lnk$/);
    assert.match(win.lnk!.target, /runtime[\\/]node\.exe$/);
    assert.match(win.lnk!.args, /^".*cli\.js" open$/);
  });
  test("samePath ignores case on Windows and macOS only", () => {
    assert.ok(samePath("C:\\A\\b", "c:\\a\\B\\", "win32"));
    assert.ok(!samePath("/a/B", "/a/b", "linux"));
  });
});

const makeIO = (answers: string[] = []): SetupIO & { all: () => string } => {
  const lines: string[] = [];
  return { interactive: true, out: (l) => void lines.push(l), err: (l) => void lines.push(l), ask: async () => answers.shift() ?? "", all: () => lines.join("\n") };
};

describe("setup from the unpacked download", () => {
  const sandbox = () => {
    const root = scratch();
    const home = join(root, "home");
    const dl = fakeBundle(join(root, "Downloads", "Monomem"), "1.7.0");
    put(join(home, ".claude.json"), "{}\n");
    const e: SetupEnv = {
      home,
      platform: "linux",
      env: { HOME: home, MONOMEM_HOME: join(root, "data") },
      cwd: root,
      nodeVersion: "26.13.1",
      execPath: join(dl, "runtime", "node"),
      cliPath: join(dl, "dist", "src", "cli.js"),
      mode: "bundle",
      version: "1.7.0",
      now: () => new Date("2026-11-16T12:00:00Z"),
    };
    return { root, home, dl, e, inst: join(home, ".local", "share", "monomem"), entry: join(home, ".local", "share", "applications", "monomem.desktop") };
  };
  const o = { ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, hook: "no" as const, capture: "no" as const };

  test("dry run: lists the copy home and the menu entry, and the settings already name the home", async () => {
    const s = sandbox();
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, { ...o, dryRun: true }), 0);
    const out = io.all();
    assert.match(out, /Copy Monomem from .*Downloads.* to .*share.monomem/);
    assert.match(out, /Add a "Monomem" entry to the applications menu/);
    assert.match(out, /Built-in runtime \(Node 26\.13\.1\): OK/);
    assert.ok(out.includes(JSON.stringify(join(s.inst, "runtime", "node")).slice(1, -1)), "the diff names the installed runtime");
    assert.ok(!out.replace(/Copy Monomem from [^\n]*/, "").includes("Downloads"), "nothing but the copy step names the download folder");
    assert.ok(!existsSync(s.inst) && !existsSync(s.entry), "a dry run changes nothing");
  });

  test("for real: copies home, writes settings naming the home, adds the entry; --undo removes the entry", async () => {
    const s = sandbox();
    assert.equal(await runSetup(s.e, makeIO(["y"]), o), 0);
    assert.ok(existsSync(join(s.inst, "runtime", "node")) && existsSync(join(s.inst, "dist", "src", "cli.js")));
    const cc = JSON.parse(readFileSync(join(s.home, ".claude.json"), "utf8"));
    assert.equal(cc.mcpServers.monomem.command, join(s.inst, "runtime", "node"));
    assert.deepEqual(cc.mcpServers.monomem.args, [join(s.inst, "dist", "src", "cli.js"), "mcp"]);
    assert.match(readFileSync(s.entry, "utf8"), /open$/m);
    assert.ok(readHistory(s.e).at(-1)!.changes.some((c) => c.client === "shortcut" && c.file === s.entry));
    const undo = makeIO();
    assert.equal(await runSetup(s.e, undo, { ...o, undo: true }), 0);
    assert.ok(!existsSync(s.entry), undo.all());
  });

  test("macOS: undo removes the whole Monomem.app it created", async () => {
    const s = sandbox();
    const e = { ...s.e, platform: "darwin" as const };
    assert.equal(await runSetup(e, makeIO(["y"]), o), 0);
    const app = join(s.home, "Applications", "Monomem.app");
    assert.ok(existsSync(join(app, "Contents", "Info.plist")) && existsSync(join(app, "Contents", "MacOS", "Monomem")));
    assert.equal(await runSetup(e, makeIO(), { ...o, undo: true }), 0);
    assert.ok(!existsSync(app));
  });

  test("run again from the installed copy: no second copy, no second entry", async () => {
    const s = sandbox();
    assert.equal(await runSetup(s.e, makeIO(["y"]), o), 0);
    const io = makeIO();
    const e2 = { ...s.e, execPath: join(s.inst, "runtime", "node"), cliPath: join(s.inst, "dist", "src", "cli.js") };
    assert.equal(await runSetup(e2, io, { ...o, dryRun: true }), 0);
    assert.doesNotMatch(io.all(), /Copy Monomem|Add a "Monomem" entry/);
  });

  test("over an npm install: check warns, setup asks to move the apps to the download, undo puts them back", async () => {
    const s = sandbox();
    const npmCli = join(s.root, "npm", "node_modules", "monomem", "dist", "src", "cli.js");
    put(npmCli, "// monomem 1.5.0 from npm");
    const data = join(s.root, "data");
    const cfg = JSON.stringify({ mcpServers: { monomem: { command: process.execPath, args: [npmCli, "mcp"], env: { MONOMEM_CLIENT: "claude-code", MONOMEM_HOME: data } } } }, null, 2) + "\n";
    put(join(s.home, ".claude.json"), cfg);
    const hookCmd = `node "${npmCli.replace(/\\/g, "/")}" recall --budget-ms 800`;
    const settings = JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup|clear|compact", hooks: [{ type: "command", command: hookCmd }] }] } }, null, 2) + "\n";
    put(join(s.home, ".claude", "settings.json"), settings);
    const { appEntryProblems } = await import("../src/setup.js");
    const e = { ...s.e, home: s.home };
    const warn = appEntryProblems(e).join("\n");
    assert.match(warn, /Claude Code: "monomem" runs another Monomem copy .*not this download/);
    assert.match(warn, /a Monomem hook runs another Monomem copy/);
    const oo = { ...o, hook: "yes" as const, only: ["claude-code"] };
    // asked first: answering no changes nothing
    const no = makeIO(["n"]);
    await runSetup(e, no, oo);
    assert.match(no.all(), /rewrite "monomem": it runs another Monomem copy/);
    assert.match(no.all(), /move Claude's Monomem hooks \(1\) to this download, same place and settings: a hook runs another Monomem copy/);
    assert.doesNotMatch(no.all(), /onememory-mcp/, "not mistaken for the old package");
    assert.equal(readFileSync(join(s.home, ".claude.json"), "utf8"), cfg);
    assert.equal(readFileSync(join(s.home, ".claude", "settings.json"), "utf8"), settings);
    assert.equal(await runSetup(e, makeIO(["y", "y"]), oo), 0);
    const cc = JSON.parse(readFileSync(join(s.home, ".claude.json"), "utf8")).mcpServers.monomem;
    assert.equal(cc.command, join(s.inst, "runtime", "node"));
    assert.deepEqual(cc.args, [join(s.inst, "dist", "src", "cli.js"), "mcp"]);
    assert.equal(cc.env.MONOMEM_HOME, data, "same data folder");
    const hooks = JSON.parse(readFileSync(join(s.home, ".claude", "settings.json"), "utf8")).hooks.SessionStart;
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].matcher, "startup|clear|compact");
    assert.match(hooks[0].hooks[0].command, /runtime\/node" ".*share\/monomem\/dist\/src\/cli\.js" recall --budget-ms 800$/);
    assert.deepEqual(appEntryProblems(e), []);
    assert.equal(await runSetup(e, makeIO(), { ...o, undo: true }), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(s.home, ".claude", "settings.json"), "utf8")), JSON.parse(settings));
    assert.deepEqual(JSON.parse(readFileSync(join(s.home, ".claude.json"), "utf8")), JSON.parse(cfg));
  });

  test("over an npm install: Cursor's start-of-session hook and this repository's commit line hook move too; check names them first", async () => {
    const s = sandbox();
    const npmCli = join(s.root, "npm", "node_modules", "monomem", "dist", "src", "cli.js");
    put(npmCli, "// monomem 1.5.0 from npm");
    const cursorFile = join(s.home, ".cursor", "hooks.json");
    const cursorText = JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "echo mine" }, { command: `node "${npmCli.replace(/\\/g, "/")}" hook cursor-session-start` }] } }, null, 2) + "\n";
    put(cursorFile, cursorText);
    const repo = join(s.root, "repo");
    mkdirSync(repo, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: repo }).status, 0);
    const { hookScript, isStale } = await import("../src/cli/commit-trail.js");
    const gitHook = join(repo, ".git", "hooks", "prepare-commit-msg");
    const npmFacts = { mode: "npm" as const, execPath: process.execPath, cliPath: npmCli, platform: s.e.platform };
    put(gitHook, hookScript(npmFacts));
    const e = { ...s.e, cwd: repo };
    const { appEntryProblems } = await import("../src/setup.js");
    assert.match(appEntryProblems(e).join("\n"), /Cursor hook: a Monomem hook runs another Monomem copy/);
    assert.equal(await runSetup(e, makeIO(["y", "y", "y", "y"]), { ...o, hook: "yes", only: ["cursor"] }), 0);
    const hooks = JSON.parse(readFileSync(cursorFile, "utf8")).hooks.sessionStart as Array<{ command: string }>;
    assert.equal(hooks.length, 2);
    assert.equal(hooks[0].command, "echo mine");
    assert.match(hooks[1].command, /runtime\/node" ".*share\/monomem\/dist\/src\/cli\.js" hook cursor-session-start$/);
    assert.deepEqual(appEntryProblems(e), []);
    const installed = { mode: "bundle" as const, execPath: join(s.inst, "runtime", "node"), cliPath: join(s.inst, "dist", "src", "cli.js"), platform: s.e.platform };
    assert.equal(isStale(gitHook, npmFacts), true, "the git hook no longer runs the npm copy");
    assert.equal(readFileSync(gitHook, "utf8"), hookScript(installed), "the git hook runs the installed download");
    // The git hook is its own setup session (like the commit line offer): the first undo puts it back, the next one Cursor's.
    assert.equal(await runSetup(e, makeIO(), { ...o, undo: true }), 0);
    assert.equal(readFileSync(gitHook, "utf8"), hookScript(npmFacts), "undo puts the old git hook back");
    assert.equal(await runSetup(e, makeIO(), { ...o, undo: true }), 0);
    assert.equal(readFileSync(cursorFile, "utf8"), cursorText);
  });

  test("an older copy at home is replaced (rename-aside), not merged", () => {
    const root = scratch();
    const home = fakeBundle(join(root, "home"), "1.6.0");
    put(join(home, "docs", "gone.md"), "old only");
    copyToInstall(fakeBundle(join(root, "dl"), "1.7.0"), home);
    assert.equal(readFileSync(join(home, "dist", "src", "cli.js"), "utf8"), "// monomem 1.7.0");
    assert.ok(!existsSync(join(home, "docs", "gone.md")));
    assert.ok(!readdirSync(home).some((n) => n.startsWith(".update-")));
  });
});

describe("setup puts the launcher folder on PATH (asked, recorded, undone exactly)", () => {
  /** A scratch bundle setup; the Windows user PATH is a fake (never the real registry or PATH). */
  const sandbox = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) => {
    const root = scratch();
    const home = join(root, "home");
    const dl = fakeBundle(join(root, "Downloads", "Monomem"), "1.7.0", platform);
    put(join(home, ".claude.json"), "{}\n");
    const reg = { v: "C:\Tools;%USERPROFILE%\bin", get(): string { return this.v; }, set(x: string): void { this.v = x; } };
    const e: SetupEnv = {
      home,
      platform,
      env: { HOME: home, MONOMEM_HOME: join(root, "data"), APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local"), ...env },
      cwd: root,
      nodeVersion: "26.13.1",
      execPath: join(dl, "runtime", platform === "win32" ? "node.exe" : "node"),
      cliPath: join(dl, "dist", "src", "cli.js"),
      mode: "bundle",
      version: "1.7.0",
      now: () => new Date("2026-11-16T12:00:00Z"),
      userPath: reg,
    };
    const inst = installDir(e);
    // The menu entry already exists, so only the PATH step is new (no PowerShell .lnk in a test).
    put(shortcutPlan(e, inst).file, "entry");
    return { root, home, e, reg, inst };
  };
  const o = { ...DEFAULT_OPTIONS, noDoctor: true, noTestNote: true, hook: "no" as const, capture: "no" as const };

  test("Linux, bash: the step is listed, a y adds one marked line to ~/.bashrc, undo removes exactly that line", async () => {
    const s = sandbox("linux", { SHELL: "/bin/bash", PATH: "/usr/bin:/bin" });
    const rc = join(s.home, ".bashrc");
    put(rc, "alias ll='ls -l'\n");
    const dry = makeIO();
    assert.equal(await runSetup(s.e, dry, { ...o, dryRun: true }), 0);
    assert.ok(dry.all().includes(`Add ${s.inst} to ${rc}`), dry.all());
    assert.equal(readFileSync(rc, "utf8"), "alias ll='ls -l'\n", "a dry run changes nothing");
    assert.equal(await runSetup(s.e, makeIO(["y"]), o), 0);
    const after = readFileSync(rc, "utf8");
    assert.ok(after.startsWith("alias ll='ls -l'\n"));
    const quoted = s.inst.replace(/(["\\$`])/g, "\\$1"); // as written inside "..." (only matters on a Windows test host)
    assert.ok(after.includes(`export PATH="${quoted}:$PATH" # added by monomem setup`), after);
    assert.equal(readHistory(s.e).at(-1)!.path?.file, rc);
    // the person adds a line of their own afterwards: undo takes out only ours
    writeFileSync(rc, after + "export EDITOR=vim\n");
    assert.equal(await runSetup(s.e, makeIO(), { ...o, undo: true }), 0);
    assert.equal(readFileSync(rc, "utf8"), "alias ll='ls -l'\nexport EDITOR=vim\n");
  });

  test("Windows: the user PATH (injected) gets the folder appended; undo removes exactly that entry and keeps later edits", async () => {
    const s = sandbox("win32", { Path: "C:\Windows" });
    assert.equal(await runSetup(s.e, makeIO(["y"]), o), 0);
    assert.equal(s.reg.v, `C:\Tools;%USERPROFILE%\bin;${s.inst}`);
    assert.equal(readHistory(s.e).at(-1)!.path?.kind, "registry");
    s.reg.v += ";D:\Later";
    assert.equal(await runSetup(s.e, makeIO(), { ...o, undo: true }), 0);
    assert.equal(s.reg.v, "C:\Tools;%USERPROFILE%\bin;D:\Later");
  });

  test("Windows: undo is byte-exact (a trailing ';' stays; a Path value setup created is removed again)", async () => {
    const { addToPath, removeFromPath } = await import("../src/install.js");
    const dir = "C:\\Users\\a\\AppData\\Local\\Programs\\Monomem";
    const fake = (v: string | null) => ({ v, get(): string | null { return this.v; }, set(x: string | null): void { this.v = x; } });
    for (const start of ["C:\\a;C:\\b;", "C:\\a;C:\\b", "", "%USERPROFILE%\\bin"]) {
      const reg = fake(start);
      const added = addToPath({ kind: "registry", dir, where: "PATH" }, reg);
      assert.ok(reg.v!.endsWith(dir));
      assert.equal(removeFromPath(JSON.parse(JSON.stringify(added)), reg), true); // the step as kept in the history file
      assert.equal(reg.v, start, JSON.stringify(start));
    }
    const none = fake(null);
    const added = addToPath({ kind: "registry", dir, where: "PATH" }, none);
    assert.equal(none.v, dir);
    removeFromPath(added, none);
    assert.equal(none.v, null, "no Path value before: none after");
  });

  test("--yes alone does not change PATH (it says how); --path adds it; already on PATH: not offered", async () => {
    const s = sandbox("win32", { Path: "C:\Windows" });
    const io = makeIO();
    assert.equal(await runSetup(s.e, io, { ...o, yes: true }), 0);
    assert.equal(s.reg.v, "C:\Tools;%USERPROFILE%\bin");
    assert.match(io.all(), /--path/);
    assert.equal(await runSetup(s.e, makeIO(), { ...o, yes: true, path: "yes" }), 0);
    assert.ok(s.reg.v.endsWith(`;${s.inst}`));
    const again = makeIO();
    assert.equal(await runSetup(s.e, again, { ...o, dryRun: true }), 0);
    assert.doesNotMatch(again.all(), /user PATH/);
    // A POSIX PATH splits on ":", so this half needs a POSIX scratch path (a Windows runner's C:\... has a drive colon).
    if (process.platform !== "win32") {
      const t = sandbox("linux", { SHELL: "/bin/zsh" });
      t.e.env.PATH = `/usr/bin:${t.inst}`;
      const io2 = makeIO();
      assert.equal(await runSetup(t.e, io2, { ...o, dryRun: true }), 0);
      assert.doesNotMatch(io2.all(), /\.zshrc/);
    }
  });
});

describe("rename-aside swap", () => {
  test("moves every entry in and the old ones aside", () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const staged = fakeBundle(join(root, ".update-1.7.0", "Monomem"), "1.7.0");
    swapIn(root, staged, join(root, ".old-1.6.0"));
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), JSON.stringify({ name: "monomem", version: "1.7.0" }));
    assert.equal(readFileSync(join(root, ".old-1.6.0", "runtime", "node"), "utf8"), "node for 1.6.0");
  });
  test("a failure half way puts every file back", () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const before = readFileSync(join(root, "dist", "src", "cli.js"), "utf8");
    const staged = fakeBundle(join(root, ".update-1.7.0", "Monomem"), "1.7.0");
    let n = 0;
    const flaky = (a: string, b: string): void => {
      if (++n === 4) throw Object.assign(new Error("disk said no"), { code: "EIO" });
      renameReal(a, b);
    };
    assert.throws(() => swapIn(root, staged, join(root, ".old-1.6.0"), flaky), /disk said no/);
    assert.equal(readFileSync(join(root, "dist", "src", "cli.js"), "utf8"), before);
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
    assert.equal(readFileSync(join(staged, "runtime", "node"), "utf8"), "node for 1.7.0");
  });
  test("an undo step that fails is reported (path and error), never 'every file was put back'", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const staged = fakeBundle(join(root, ".update-1.7.0", "Monomem"), "1.7.0");
    let n = 0;
    const flaky = (a: string, b: string): void => {
      n++;
      if (n === 4) throw Object.assign(new Error("disk said no"), { code: "EIO" });
      if (n === 5) throw Object.assign(new Error("still locked"), { code: "EBUSY" }); // the first undo step
      renameReal(a, b);
    };
    let err: Error & { undoFailed?: string[] } = new Error("none");
    try {
      swapIn(root, staged, join(root, ".old-1.6.0"), flaky);
    } catch (e) {
      err = e as typeof err;
    }
    assert.match(err.message, /disk said no/);
    assert.equal(err.undoFailed?.length, 1);
    assert.match(err.undoFailed![0], /still locked/);
    // runUpdate says which, and does not claim everything was put back
    const r2 = fakeBundle(scratch(), "1.6.0");
    const lines: string[] = [];
    let m = 0;
    const code = await runUpdate({ check: false }, {
      mode: "bundle", root: r2, version: "1.6.0", platform: "linux", arch: "x64", env: {},
      fetch: (async (url: string | URL) => {
        const u = String(url);
        const archive = Buffer.from("a");
        if (u.includes("/releases/latest")) return new Response(JSON.stringify({ tag_name: "v1.7.0", assets: [{ name: "monomem-1.7.0-linux-x64.tar.gz", browser_download_url: "https://dl/a" }, { name: "SHA256SUMS", browser_download_url: "https://dl/s" }] }));
        if (u === "https://dl/s") return new Response(`${createHash("sha256").update(archive).digest("hex")}  monomem-1.7.0-linux-x64.tar.gz\n`);
        return new Response(archive);
      }) as typeof fetch,
      out: (l) => void lines.push(l), err: (l) => void lines.push(l),
      unpack: (_a, into) => void fakeBundle(join(into, "Monomem"), "1.7.0"),
      run: (cmd) => ({ status: 0, stdout: readFileSync(cmd, "utf8").replace("node for ", "") + "\n" }),
      rename: (a, b) => {
        m++;
        if (m === 4) throw Object.assign(new Error("disk said no"), { code: "EIO" });
        if (m === 5) throw Object.assign(new Error("still locked"), { code: "EBUSY" });
        renameReal(a, b);
      },
    });
    assert.equal(code, 1);
    const all = lines.join("\n");
    assert.doesNotMatch(all, /every file was put back/);
    assert.match(all, /could not be put back.*still locked/s);
  });
  test("Windows: works while the folder's node.exe is running (it is renamed, never overwritten)", { skip: process.platform !== "win32" }, async () => {
    const root = scratch();
    fakeBundle(root, "1.6.0", "win32");
    copyFileSync(process.execPath, join(root, "runtime", "node.exe"));
    const child = spawn(join(root, "runtime", "node.exe"), ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const staged = fakeBundle(join(root, ".update-1.7.0", "Monomem"), "1.7.0", "win32");
      swapIn(root, staged, join(root, ".old-1.6.0"));
      assert.equal(readFileSync(join(root, "runtime", "node.exe"), "utf8"), "node for 1.7.0");
      assert.ok(existsSync(join(root, ".old-1.6.0", "runtime", "node.exe")));
    } finally {
      const gone = new Promise((r) => child.once("exit", r));
      child.kill();
      await gone;
    }
  });
  test("cleanupOld removes earlier leftovers only", () => {
    const root = fakeBundle(scratch(), "1.6.0");
    put(join(root, ".old-1.5.0", "x"), "x");
    put(join(root, ".update-1.6.0", "y"), "y");
    cleanupOld(root);
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith(".")), []);
    assert.ok(existsSync(join(root, "runtime", "node")));
  });
  test("cleanupOld skips a leftover still in use (an open app's node.exe) and never throws", () => {
    const root = fakeBundle(scratch(), "1.6.0");
    put(join(root, ".old-1.5.0", "runtime", "node.exe"), "held");
    put(join(root, ".update-1.6.0", "y"), "y");
    const locked = (p: string): void => {
      if (p.includes(".old-1.5.0")) throw Object.assign(new Error("EPERM, Permission denied"), { code: "EPERM" });
      rmSync(p, { recursive: true, force: true });
    };
    assert.deepEqual(cleanupOld(root, locked), [".old-1.5.0"]);
    assert.ok(!existsSync(join(root, ".update-1.6.0")));
  });
});

describe("monomem update", () => {
  const ARCHIVE = Buffer.from("pretend this is a tar.gz");
  const sha = createHash("sha256").update(ARCHIVE).digest("hex");
  const release = (sums = `${sha}  monomem-1.7.0-linux-x64.tar.gz\n`) => ({
    tag_name: "v1.7.0",
    assets: [
      { name: "monomem-1.7.0-linux-x64.tar.gz", browser_download_url: "https://dl/archive" },
      { name: "SHA256SUMS", browser_download_url: "https://dl/sums" },
    ],
    sums,
  });
  const deps = (root: string, rel: ReturnType<typeof release> | null, over: Partial<UpdateDeps> = {}) => {
    const lines: string[] = [];
    const runs: string[][] = [];
    const fakeFetch = (async (url: string | URL) => {
      const u = String(url);
      if (!rel) throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.github.com");
      if (u.includes("/releases/latest")) return new Response(JSON.stringify(rel));
      if (u === "https://dl/sums") return new Response(rel.sums);
      if (u === "https://dl/archive") return new Response(ARCHIVE);
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const d: UpdateDeps = {
      mode: "bundle",
      root,
      version: "1.6.0",
      platform: "linux",
      arch: "x64",
      env: {},
      fetch: fakeFetch,
      out: (l) => void lines.push(l),
      err: (l) => void lines.push(l),
      unpack: (_a, into) => void fakeBundle(join(into, "Monomem"), "1.7.0"),
      run: (cmd, args) => {
        runs.push([cmd, ...args]);
        return { status: 0, stdout: args.includes("--version") ? readFileSync(cmd, "utf8").replace("node for ", "") + "\n" : "" };
      },
      ...over,
    };
    return { d, lines, runs, all: () => lines.join("\n") };
  };

  test("downloads, checks the SHA-256, swaps in place, then the new copy finishes (migration + service)", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, release());
    assert.equal(await runUpdate({ check: false }, t.d), 0, t.all());
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.7.0");
    assert.match(t.all(), new RegExp(`SHA-256 checked: ${sha}`));
    const fin = t.runs.at(-1)!;
    assert.deepEqual(fin, [join(root, "runtime", "node"), join(root, "dist", "src", "cli.js"), "update", "--finish", "1.6.0"]);
    assert.ok(!existsSync(join(root, ".update-1.7.0")), "the download is cleaned up");
  });

  test("a checksum mismatch changes nothing and says so", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, release(`${"0".repeat(64)}  monomem-1.7.0-linux-x64.tar.gz\n`));
    assert.equal(await runUpdate({ check: false }, t.d), 1);
    assert.match(t.all(), /does not match its checksum.*Nothing was changed/s);
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
    assert.ok(!existsSync(join(root, ".update-1.7.0")));
  });

  test("offline: a clear error, exit 1, nothing changed", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, null);
    assert.equal(await runUpdate({ check: false }, t.d), 1);
    assert.match(t.all(), /Could not reach github\.com to look for an update \(fetch failed.*\)\. Nothing was changed/);
  });

  test("a release tag that is not exactly a version is refused before any folder is touched (r3 security L1)", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    mkdirSync(join(root, "victim"), { recursive: true });
    writeFileSync(join(root, "victim", "keep.txt"), "x");
    const t = deps(root, { ...release(), tag_name: "v1.7.0/../victim" });
    assert.equal(await runUpdate({ check: false }, t.d), 1);
    assert.match(t.all(), /no version number I understand/);
    assert.ok(existsSync(join(root, "victim", "keep.txt")), "nothing outside the update folder was removed");
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
  });

  test("a new copy that does not start is never swapped in", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, release(), { run: () => ({ status: 1, stdout: "" }) });
    assert.equal(await runUpdate({ check: false }, t.d), 1);
    assert.match(t.all(), /did not start properly/);
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
  });

  test("--check only asks; up to date says so; npm installs get the npm command", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const c = deps(root, release());
    assert.equal(await runUpdate({ check: true }, c.d), 0);
    assert.match(c.all(), /Monomem 1\.7\.0 is out \(you have 1\.6\.0\)/);
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.6.0");
    const same = deps(root, release(), { version: "1.7.0" });
    assert.equal(await runUpdate({ check: false }, same.d), 0);
    assert.match(same.all(), /1\.7\.0 is the newest version/);
    const npm = deps(root, null, { mode: "npm" });
    assert.equal(await runUpdate({ check: false }, npm.d), 0);
    assert.match(npm.all(), /npm i -g monomem@latest/);
  });

  test("--check never deletes the old copy a failed update tells the person to restore from", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    put(join(root, ".old-1.5.0", "x"), "rollback copy");
    assert.equal(await runUpdate({ check: true }, deps(root, release()).d), 0);
    assert.ok(existsSync(join(root, ".old-1.5.0", "x")));
  });

  test("an earlier update's leftovers still in use: the update goes on, says so, and swaps aside under a fresh name", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    put(join(root, ".old-1.6.0", "runtime", "node"), "held by an open app");
    const locked = (p: string): void => {
      if (p.endsWith(".old-1.6.0")) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      rmSync(p, { recursive: true, force: true });
    };
    const t = deps(root, release(), { remove: locked });
    assert.equal(await runUpdate({ check: false }, t.d), 0, t.all());
    assert.equal(readFileSync(join(root, "runtime", "node"), "utf8"), "node for 1.7.0");
    assert.match(t.all(), /still in use by an open app.*\.old-1\.6\.0/);
    assert.equal(readFileSync(join(root, ".old-1.6.0", "runtime", "node"), "utf8"), "held by an open app");
    assert.ok(readdirSync(root).some((n) => /^\.old-1\.6\.0-\d+$/.test(n)), "the replaced files went to a fresh aside folder");
  });

  test("from the dashboard: the new copy is told which server to restart", async () => {
    const root = fakeBundle(scratch(), "1.6.0");
    const t = deps(root, release(), { restartServer: 4242 });
    assert.equal(await runUpdate({ check: false }, t.d), 0, t.all());
    assert.deepEqual(t.runs.at(-1)!.slice(2), ["update", "--finish", "1.6.0", "--restart-server", "4242"]);
  });

  describe("restarting the dashboard's server after the swap (no real process)", () => {
    const fake = (o: { stops?: boolean; up?: boolean } = {}) => {
      const calls: string[] = [];
      let alive = true;
      const r: RestartDeps = {
        kill: (pid) => {
          calls.push(`kill ${pid}`);
          if (o.stops !== false) alive = false;
        },
        alive: () => alive,
        startServer: () => void calls.push("start"),
        waitUp: async () => o.up !== false,
        sleep: async () => undefined,
      };
      return { r, calls };
    };
    test("no service (Start menu, monomem open): stops the old server, then starts the new one", async () => {
      const f = fake();
      const lines: string[] = [];
      assert.equal(await restartServerAfterUpdate(77, false, f.r, (l) => void lines.push(l)), true);
      assert.deepEqual(f.calls, ["kill 77", "start"]);
      assert.match(lines.join("\n"), /running the new version/);
    });
    test("with the service: stops the old server and leaves the start to the service", async () => {
      const f = fake();
      assert.equal(await restartServerAfterUpdate(77, true, f.r, () => undefined), true);
      assert.deepEqual(f.calls, ["kill 77"]);
    });
    test("a server that will not stop, or a new one that does not answer: says what to do", async () => {
      const lines: string[] = [];
      assert.equal(await restartServerAfterUpdate(77, false, fake({ stops: false }).r, (l) => void lines.push(l)), false);
      assert.equal(await restartServerAfterUpdate(77, false, fake({ up: false }).r, (l) => void lines.push(l)), false);
      assert.match(lines.join("\n"), /did not stop.*monomem open[\s\S]*did not start.*monomem open/);
    });
    test("Linux with the service: update.log gets its end line BEFORE systemctl restart (which ends this update too)", async () => {
      const { finishUpdate, UPDATE_END } = await import("../src/update.js");
      for (const platform of ["linux", "win32", "darwin"] as const) {
        const log: string[] = [];
        const run = (_c: string, a: string[]) => {
          log.push(`run ${a.slice(-2).join(" ")}`);
          return { status: 0, stdout: "" };
        };
        assert.equal(await finishUpdate("1.5.0", (l) => void log.push(l), run, 77, fake().r, platform), 0);
        const end = log.indexOf(UPDATE_END(0));
        const install = log.indexOf("run service install");
        assert.ok(install > 0, log.join("\n"));
        if (platform === "linux") {
          assert.ok(end >= 0 && end < install, `end line first on Linux:\n${log.join("\n")}`);
          assert.ok(log.slice(0, end).some((l) => /^Updated from 1\.5\.0 to /.test(l)), "the closing words come with it");
        } else assert.equal(end, -1, `${platform}: the update command itself writes the end line`);
      }
    });
  });

  test("one CI run on the tag gates both the download upload and npm; a published file is never replaced; every src/ PR builds the download", () => {
    const wf = readFileSync(join(REPO, ".github", "workflows", "bundle.yml"), "utf8");
    const pub = readFileSync(join(REPO, ".github", "workflows", "publish.yml"), "utf8");
    // bundle.yml: no tag trigger and no CI of its own (a second CI run on the tag could flake alone and split the release).
    const on = /\non:\n((?:[ #].*\n|\n)*?)(?=\S)/.exec(wf)![1];
    assert.doesNotMatch(on, /tags:/, "a tag must not start bundle.yml by itself");
    assert.match(on, /workflow_call:\n\s+inputs:\n\s+upload:/);
    assert.doesNotMatch(wf, /uses: \.\/\.github\/workflows\/ci\.yml/);
    assert.match(wf, /if: inputs\.upload && github\.ref_type == 'tag'/, "only the caller's upload: true uploads (never a hand run)");
    // publish.yml: CI once; the download (built, smoke-tested, uploaded) after it; npm only after the upload succeeded.
    assert.equal(pub.match(/uses: \.\/\.github\/workflows\/ci\.yml/g)?.length, 1, "CI runs once per tag");
    assert.match(pub, /\n  bundle:\n    needs: \[verify\]\n    uses: \.\/\.github\/workflows\/bundle\.yml\n    with:\n      upload: true\n/);
    assert.match(pub, /\n  publish:\n    needs: \[verify, bundle\]\n/);
    assert.match(pub, /\n  bundle:\n(?:    .*\n|      .*\n)*?    permissions:\n      contents: write.*\n      id-token: write.*\n      attestations: write\n/, "the called upload gets the rights it needs");
    assert.match(wf, /isDraft[\s\S]*--clobber[\s\S]*else[\s\S]*gh release upload "\$tag" out\/monomem-\* out\/SHA256SUMS\n/);
    assert.match(wf, /paths:\n\s+- src\/\*\*\n/);
    const smoke = readFileSync(join(REPO, "scripts", "smoke-bundle.mjs"), "utf8");
    assert.match(smoke, /\/health/);
    assert.match(smoke, /"service", "install", "--print"/);
    assert.doesNotMatch(smoke, /\|\| \/Monomem\|database\/i/, "doctor must really pass, not just print the name");
  });

  test("the CLI knows `update` and never runs it from a hook", () => {
    const r = spawnSync(process.execPath, [CLI, "update", "--bogus"], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: monomem update \[--check\]/);
    const hookSrc = readFileSync(join(REPO, "src", "hook.ts"), "utf8") + readFileSync(join(REPO, "src", "recall.ts"), "utf8");
    assert.doesNotMatch(hookSrc, /update\.js|runUpdate/);
  });
});

describe("no command", () => {
  test("bare monomem prints the help even with no terminal (an agent, a pipe, cron); only an explicit open starts a server", () => {
    // r3 SF-3: the launchers (monomem.cmd's double-click check, the Start-menu .lnk, the .app, the .desktop) all pass `open`.
    assert.match(readFileSync(join(REPO, "src", "cli.ts"), "utf8"), /const cmd = process\.argv\[2\] \|\| "help";/);
    // Safe to spawn only once the line above holds (before, it started a server and opened a browser).
    const home = scratch();
    const r = spawnSync(process.execPath, [CLI], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, USERPROFILE: home, MONOMEM_HOME: join(home, "data"), NO_COLOR: "1" },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /monomem <command>/);
    assert.doesNotMatch(r.stdout + r.stderr, /Starting Monomem|Opened the dashboard/);
  });
});
